import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  DatabaseRaidService, RaidError, type CheckinInput, type CheckinResponse,
  type RaidPointPresenceRoster, type RaidProjection,
} from './raids.js'

export type TeamVisitInput = Omit<CheckinInput, 'organizerAttestation'> & {
  confirmedAttendance: true
  previousAttemptId?: string | null | undefined
}
export type FieldAccess = {
  id: string; kabanda_id: string; state: string; version: number
  navigator_user_id: string | null; organizer_user_id: string
  route_template_id: string | null; participant_state: string | null
  active_from: Date | null; role: string; server_at: Date
}
export type FieldPosition = {
  userId: string; latitude: number; longitude: number; accuracyMeters: number; capturedAt: string
}
export type FastSnapshot = {
  raid: RaidProjection; revision: string; pointsRevision: string; serverAt: string
  teamVisits: true; fieldVisible: boolean; positions: FieldPosition[]
  points?: Array<{
    id: string; sourcePointId: string; name: string; latitude: number; longitude: number
    position: number; visitedByMe: boolean; visitedByTeam: boolean; lastAttemptId: string | null
  }>
  claims: unknown[]; fallbacks: unknown[]
}

export async function fieldAccess(client: PoolClient, userId: string, raidId: string, lock = false): Promise<FieldAccess> {
  const result = await client.query<FieldAccess>(
    `SELECT r.id,r.kabanda_id,r.state,r.version,r.navigator_user_id,r.organizer_user_id,
       r.route_template_id,p.state AS participant_state,p.active_from,m.role,clock_timestamp() AS server_at
     FROM raids r JOIN kabandas k ON k.id=r.kabanda_id AND k.archived_at IS NULL
     JOIN kabanda_memberships m ON m.kabanda_id=r.kabanda_id AND m.user_id=$2 AND m.removed_at IS NULL
     LEFT JOIN raid_participants p ON p.raid_id=r.id AND p.user_id=$2
     WHERE r.id=$1 ${lock ? 'FOR UPDATE OF r' : ''}`, [raidId, userId],
  )
  const row = result.rows[0]
  if (!row) throw new RaidError('RAID_NOT_FOUND', 404, 'Рейд недоступен')
  return row
}
export function canReadField(access: FieldAccess): boolean {
  return access.role === 'owner' || access.participant_state === 'active' || access.state === 'completed'
}
export async function fieldTransaction<T>(pool: Pool, task: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const value = await task(client)
    await client.query('COMMIT')
    return value
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

/** Additive endpoints: installed clients and already saved v1 operations retain
 * their original protocol. No historical result is recomputed here. */
export class FieldRaidService extends DatabaseRaidService {
  constructor(readonly fieldPool: Pool, secret: string) { super(fieldPool, secret) }

  async getFastSnapshot(actorUserId: string, raidId: string, knownPointsRevision?: string): Promise<FastSnapshot> {
    const raid = await this.getRaid(actorUserId, raidId)
    const client = await this.fieldPool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const access = await fieldAccess(client, actorUserId, raidId)
      if (raid.version !== access.version || raid.state !== access.state) {
        throw new RaidError('SYNC_RETRY', 409, 'Состояние обновилось. Повторяем чтение.')
      }
      const revision = await client.query<{ revision: string; points_revision: string }>(
        'SELECT revision::text,points_revision::text FROM raid_sync_revisions WHERE raid_id=$1', [raidId],
      )
      const fieldVisible = canReadField(access) && ['active', 'paused', 'finalizing', 'completed'].includes(access.state)
      const result: FastSnapshot = {
        raid, revision: revision.rows[0]?.revision ?? '0', pointsRevision: revision.rows[0]?.points_revision ?? '0',
        serverAt: access.server_at.toISOString(), teamVisits: true, fieldVisible, positions: [], claims: [], fallbacks: [],
      }
      if (fieldVisible && knownPointsRevision !== result.pointsRevision) {
        const points = await client.query(
          `SELECT s.id,s.source_point_id,s.name,ST_Y(s.location::geometry) AS latitude,
             ST_X(s.location::geometry) AS longitude,s.position,
             EXISTS(SELECT 1 FROM raid_point_credits c WHERE c.raid_id=s.raid_id AND c.point_snapshot_id=s.id AND c.user_id=$2) AS mine,
             EXISTS(SELECT 1 FROM raid_point_credits c WHERE c.raid_id=s.raid_id AND c.point_snapshot_id=s.id) AS team,
             (SELECT a.id FROM raid_checkin_attempts a WHERE a.raid_id=s.raid_id AND a.point_snapshot_id=s.id
               AND EXISTS(SELECT 1 FROM raid_point_visit_events e WHERE e.evidence_attempt_id=a.id)
               ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS last_attempt_id
           FROM raid_point_snapshots s WHERE s.raid_id=$1 ORDER BY s.position,s.id LIMIT 500`, [raidId, actorUserId],
        )
        result.points = points.rows.map(row => ({
          id: row.id, sourcePointId: row.source_point_id, name: row.name,
          latitude: Number(row.latitude), longitude: Number(row.longitude), position: Number(row.position),
          visitedByMe: row.mine, visitedByTeam: row.team, lastAttemptId: row.last_attempt_id,
        }))
      }
      if (fieldVisible && ['active', 'paused'].includes(access.state)) {
        const positions = await client.query(
          `SELECT p.user_id,ST_Y(g.location::geometry) AS latitude,ST_X(g.location::geometry) AS longitude,
             g.accuracy_meters,g.captured_at
           FROM raid_participants p JOIN kabanda_memberships m ON m.kabanda_id=$2 AND m.user_id=p.user_id AND m.removed_at IS NULL
           JOIN raid_presence_reports g ON g.raid_id=p.raid_id AND g.user_id=p.user_id
           WHERE p.raid_id=$1 AND p.state='active' AND g.accuracy_meters<=50
             AND g.captured_at<=clock_timestamp()+interval '5 seconds'
             AND g.captured_at>=clock_timestamp()-interval '5 minutes' ORDER BY p.user_id`, [raidId, access.kabanda_id],
        )
        result.positions = positions.rows.map(row => ({
          userId: row.user_id, latitude: Number(row.latitude), longitude: Number(row.longitude),
          accuracyMeters: Number(row.accuracy_meters), capturedAt: row.captured_at.toISOString(),
        }))
      }
      if (access.participant_state === 'active' && ['active', 'finalizing'].includes(access.state)) {
        const claims = await client.query(
          `SELECT id,attempt_id,user_id,status,expires_at FROM raid_checkin_claims
           WHERE raid_id=$1 AND user_id=$2 AND status='pending' AND expires_at>clock_timestamp()
           ORDER BY created_at,id LIMIT 20`, [raidId, actorUserId],
        )
        const fallbacks = await client.query(
          `SELECT id,attempt_id,media_id,verifier_user_id,status,reason,expires_at FROM raid_checkin_fallbacks
           WHERE raid_id=$1 AND verifier_user_id=$2 AND status='pending_verifier' AND expires_at>clock_timestamp()
           ORDER BY created_at,id LIMIT 20`, [raidId, actorUserId],
        )
        result.claims = claims.rows.map(row => ({ id: row.id, attemptId: row.attempt_id, userId: row.user_id, status: row.status, expiresAt: row.expires_at.toISOString() }))
        result.fallbacks = fallbacks.rows.map(row => ({ id: row.id, attemptId: row.attempt_id, mediaId: row.media_id, verifierUserId: row.verifier_user_id, status: row.status, reason: row.reason, expiresAt: row.expires_at.toISOString() }))
      }
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }

  override async getPointPresence(actorUserId: string, raidId: string, pointSnapshotId: string): Promise<RaidPointPresenceRoster> {
    return fieldTransaction(this.fieldPool, async client => {
      const access = await fieldAccess(client, actorUserId, raidId)
      if (access.state !== 'active' || access.participant_state !== 'active' ||
        (access.navigator_user_id !== actorUserId && access.organizer_user_id !== actorUserId)) {
        throw new RaidError('RAID_COMMAND_FORBIDDEN', 403, 'Состав подтверждает навигатор')
      }
      const point = await client.query('SELECT 1 FROM raid_point_snapshots WHERE raid_id=$1 AND id=$2', [raidId, pointSnapshotId])
      if (!point.rowCount) throw new RaidError('POINT_NOT_FOUND', 404, 'Точка недоступна')
      const rows = await client.query(
        `SELECT p.user_id AS id,
           CASE WHEN g.expires_at>clock_timestamp() AND g.accuracy_meters<=50 AND ST_DWithin(g.location,s.location,50)
             THEN 'nearby' ELSE 'waiting' END AS status,
           CASE WHEN g.expires_at>clock_timestamp() AND g.accuracy_meters<=50 AND ST_DWithin(g.location,s.location,50)
             THEN g.captured_at ELSE NULL END AS observed_at
         FROM raid_participants p JOIN kabanda_memberships m ON m.kabanda_id=$3 AND m.user_id=p.user_id AND m.removed_at IS NULL
         CROSS JOIN raid_point_snapshots s LEFT JOIN raid_presence_reports g ON g.raid_id=p.raid_id AND g.user_id=p.user_id
         WHERE p.raid_id=$1 AND s.id=$2 AND s.raid_id=p.raid_id AND p.state='active' ORDER BY p.invited_at,p.user_id`, [raidId, pointSnapshotId, access.kabanda_id],
      )
      return { pointSnapshotId, radiusMeters: 50, serverAt: access.server_at.toISOString(), participants: rows.rows.map(row => ({ id: row.id, status: row.status, observedAt: row.observed_at?.toISOString() ?? null })) }
    })
  }

  async createTeamVisit(actorUserId: string, raidId: string, input: TeamVisitInput, operationId: string): Promise<CheckinResponse> {
    const ids = [...new Set([actorUserId, ...input.presentParticipantIds])].sort()
    if (ids.length > 20 || input.confirmedAttendance !== true) {
      throw new RaidError('ATTENDANCE_REQUIRED', 400, 'Подтвердите состав на этой остановке')
    }
    const requestFingerprint = createHash('sha256').update(JSON.stringify({
      command: 'team-visit-v1', raidId, pointSnapshotId: input.pointSnapshotId,
      evidence: input.evidence, ids, repeatVisit: !!input.repeatVisit, previousAttemptId: input.previousAttemptId ?? null,
    })).digest('hex')
    return fieldTransaction(this.fieldPool, async client => {
      // The raid row coordinates legacy commands, handoff and finish. The
      // operation lock also serializes accidental key reuse across raids.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`field:${actorUserId}:${operationId}`])
      const access = await fieldAccess(client, actorUserId, raidId, true)
      const receipt = await client.query(
        'SELECT raid_id,command,request_fingerprint,response_json FROM raid_feature_receipts WHERE actor_user_id=$1 AND operation_id=$2', [actorUserId, operationId],
      )
      const old = receipt.rows[0]
      if (old) {
        if (old.raid_id !== raidId || old.command !== 'team-visit-v1' || old.request_fingerprint !== requestFingerprint) {
          throw new RaidError('IDEMPOTENCY_CONFLICT', 409, 'Эта операция уже имеет другое содержимое')
        }
        return old.response_json as CheckinResponse
      }
      if (access.state !== 'active' || access.participant_state !== 'active' || access.navigator_user_id !== actorUserId) {
        throw new RaidError('NAVIGATOR_REQUIRED', 403, 'Командное посещение подтверждает действующий навигатор')
      }
      if (input.repeatVisit && access.route_template_id) {
        throw new RaidError('RAID_REPEAT_NOT_ALLOWED', 409, 'На выбранном маршруте точка засчитывается один раз')
      }
      const members = await client.query(
        `SELECT p.user_id FROM raid_participants p JOIN kabanda_memberships m
           ON m.kabanda_id=$2 AND m.user_id=p.user_id AND m.removed_at IS NULL
         WHERE p.raid_id=$1 AND p.user_id=ANY($3::uuid[]) AND p.state='active' FOR SHARE OF p,m`, [raidId, access.kabanda_id, ids],
      )
      if (members.rowCount !== ids.length) throw new RaidError('ATTENDANCE_CHANGED', 409, 'Состав рейда изменился. Проверьте выбранных участников.')
      const point = (await client.query(
        `SELECT id,source_point_id,name,ST_Distance(location,ST_SetSRID(ST_MakePoint($3,$2),4326)::geography) AS distance
         FROM raid_point_snapshots WHERE id=$1 AND raid_id=$4`, [input.pointSnapshotId, input.evidence.latitude, input.evidence.longitude, raidId],
      )).rows[0]
      if (!point) throw new RaidError('POINT_NOT_FOUND', 404, 'Точка недоступна')
      const previous = (await client.query(
        `SELECT a.id FROM raid_checkin_attempts a WHERE a.raid_id=$1 AND a.point_snapshot_id=$2
           AND EXISTS(SELECT 1 FROM raid_point_visit_events e WHERE e.evidence_attempt_id=a.id)
         ORDER BY a.created_at DESC,a.id DESC LIMIT 1`, [raidId, point.id],
      )).rows[0]?.id ?? null
      if ((!input.repeatVisit && previous) || (input.repeatVisit && (!previous || previous !== input.previousAttemptId))) {
        throw new RaidError('TEAM_VISIT_ALREADY_CONFIRMED', 409, 'Точка уже отмечена. Откройте её историю перед новым посещением.')
      }
      const age = access.server_at.getTime() - Date.parse(input.evidence.capturedAt)
      const distance = Number(point.distance)
      const reason: CheckinResponse['reason'] = !Number.isFinite(age) || age > 60_000 || age < -30_000 ? 'location_expired'
        : !Number.isFinite(input.evidence.accuracyMeters) || input.evidence.accuracyMeters > 50 ? 'accuracy_insufficient'
          : !Number.isFinite(distance) || distance > 50 ? 'too_far' : null
      const attempt = (await client.query(
        `INSERT INTO raid_checkin_attempts
           (raid_id,point_snapshot_id,actor_user_id,evidence_location,evidence_captured_at,evidence_accuracy_meters,
            organizer_attestation,outcome,reason,distance_meters,repeat_visit)
         VALUES($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,$6,$7,false,$8,$9,$10,$11) RETURNING id`,
        [raidId, point.id, actorUserId, input.evidence.longitude, input.evidence.latitude, input.evidence.capturedAt,
          input.evidence.accuracyMeters, reason ? 'needs_manual_verification' : 'accepted', reason, distance, !!input.repeatVisit],
      )).rows[0]!.id
      const credits: CheckinResponse['credits'] = []
      if (!reason) {
        await client.query(
          `INSERT INTO raid_navigator_attestations(attempt_id,raid_id,navigator_user_id,participant_ids,previous_attempt_id)
           VALUES($1,$2,$3,$4::uuid[],$5)`, [attempt, raidId, actorUserId, ids, previous],
        )
        await client.query(
          `INSERT INTO raid_point_credits(raid_id,point_snapshot_id,user_id,source,evidence_attempt_id)
           SELECT $1,$2,x,'navigator_attestation',$3 FROM unnest($4::uuid[]) x
           ON CONFLICT(raid_id,point_snapshot_id,user_id) DO NOTHING`, [raidId, point.id, attempt, ids],
        )
        await client.query(
          `INSERT INTO raid_point_visit_events(credit_id,evidence_attempt_id,user_id,source)
           SELECT id,$3,user_id,'navigator_attestation' FROM raid_point_credits
           WHERE raid_id=$1 AND point_snapshot_id=$2 AND user_id=ANY($4::uuid[])
           ON CONFLICT(evidence_attempt_id,user_id) DO NOTHING`, [raidId, point.id, attempt, ids],
        )
        // Only the newly committed visit clears its own reached destination.
        // Replaying its receipt exits above and cannot erase a later target.
        await client.query(
          `UPDATE raids SET destination_point_id=NULL,destination_selected_at=NULL,
             version=version+1,updated_at=clock_timestamp()
           WHERE id=$1 AND destination_point_id=$2 AND navigator_user_id=$3`, [raidId, point.id, actorUserId],
        )
        const rows = await client.query(
          'SELECT id,user_id,point_snapshot_id,source,created_at FROM raid_point_credits WHERE raid_id=$1 AND point_snapshot_id=$2 AND user_id=ANY($3::uuid[])', [raidId, point.id, ids],
        )
        credits.push(...rows.rows.map(row => ({ id: row.id, userId: row.user_id, pointSnapshotId: row.point_snapshot_id, source: row.source, creditedAt: row.created_at.toISOString() })))
      }
      const response: CheckinResponse = {
        operationId, attemptId: attempt, outcome: reason ? 'needs_manual_verification' : 'accepted', reason,
        point: { pointSnapshotId: point.id, sourcePointId: point.source_point_id, name: point.name },
        distanceMeters: Math.round(distance * 10) / 10, credits, claims: [],
      }
      await client.query(
        `INSERT INTO raid_feature_receipts(actor_user_id,operation_id,raid_id,command,request_fingerprint,response_json)
         VALUES($1,$2,$3,'team-visit-v1',$4,$5)`, [actorUserId, operationId, raidId, requestFingerprint, response],
      )
      return response
    })
  }
}
