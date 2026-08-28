import { createHash, randomUUID } from 'node:crypto'
import {
  getRaidAllowedActions,
  getRouteStatusCode,
  isRaidStateTransitionAllowed,
  type RaidAction,
  type RaidParticipantState,
  type RaidState,
  type RouteStatusCode,
} from '@kabanda/domain'
import type { Pool, PoolClient } from 'pg'

export class RaidError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export type CreateRaidInput = {
  title: string
  description?: string | null | undefined
  scheduledAt?: string | null | undefined
}

export type ReadinessInput = {
  expectedVersion: number
  appMode: 'browser' | 'standalone'
  locationPermission: 'granted' | 'prompt' | 'denied' | 'unsupported' | 'unknown'
  coordinateMeasuredAt: string | null
  accuracyM: number | null
  indexedDbWritable: boolean
  storageAvailable: boolean | null
  online: boolean
  measuredAt: string
}

export type RaidCommandInput = {
  expectedVersion: number
  navigatorUserId?: string
}

export type NavigatorLeaseInput = {
  expectedVersion: number
  clientInstanceId: string
}

export type RouteSampleInput = {
  operationId: string
  sequence: number
  capturedAt: string
  latitude: number
  longitude: number
  accuracyM: number
  speedMps?: number | undefined
  headingDeg?: number | undefined
}

export type RouteBatchInput = {
  schemaVersion: 1
  leaseId: string
  clientInstanceId: string
  samples: RouteSampleInput[]
}

export type RouteStatusProjection = {
  status: RouteStatusCode
  navigatorUserId: string | null
  generation: number | null
  lastSampleAt: string | null
  lastReceivedAt: string | null
  acceptedSampleCount: number
  missingSequenceCount: number
}

export type NavigatorLeaseProjection = {
  id: string
  generation: number
  issuedAt: string
}

export type RaidParticipantProjection = {
  id: string
  displayName: string
  avatarUrl: string | null
  state: RaidParticipantState
}

export type RaidProjection = {
  id: string
  kabandaId: string
  title: string
  description: string | null
  scheduledAt: string | null
  state: RaidState
  version: number
  organizerUserId: string
  navigatorUserId: string | null
  navigatorReady: boolean
  navigatorBlockers: string[]
  navigatorWarnings: string[]
  routeStatus: RouteStatusProjection
  navigatorLease: NavigatorLeaseProjection | null
  participants: RaidParticipantProjection[]
  allowedActions: RaidAction[]
}

export type RaidCommandResponse = {
  receipt: {
    operationId: string
    command: string
    resultingVersion: number
    serverAt: string
  }
  raid: RaidProjection
}

export type RaidReadinessResponse = {
  report: {
    status: 'pass' | 'warn' | 'fail'
    blockers: string[]
    expiresAt: string
    raidVersion: number
  }
  raid: RaidProjection
}

export type RaidLeaseResponse = {
  receipt: {
    operationId: string
    command: 'acquire-route' | 'recover-route'
    serverAt: string
  }
  raid: RaidProjection
}

export type RouteBatchResponse = {
  batchId: string
  accepted: Array<{ operationId: string; acceptedAt: string }>
  duplicates: Array<{ operationId: string }>
  rejected: Array<{ operationId: string; code: string }>
  routeStatus: RouteStatusProjection
  serverAt: string
}

type RaidRow = {
  id: string
  kabanda_id: string
  organizer_user_id: string
  navigator_user_id: string | null
  title: string
  description: string | null
  scheduled_at: Date | null
  state: RaidState
  version: number
  membership_role: 'owner' | 'member'
  participant_state: RaidParticipantState | null
}

type ReadinessRow = {
  blocker_codes: string[]
  warning_codes: string[]
}

type StoredReadinessRow = ReadinessRow & {
  expires_at: Date
}

type LeaseRow = {
  id: string
  navigator_user_id: string
  client_instance_id: string | null
  generation: number
  issued_at: Date
  claimed_at: Date | null
  heartbeat_expires_at: Date | null
  ended_at: Date | null
  max_accepted_sequence: string | number
  accepted_sample_count: number
}

const visibleParticipantStates: RaidParticipantState[] = [
  'invited',
  'accepted',
  'ready',
  'active',
]

function fingerprint(command: string, target: string, input: unknown): string {
  return createHash('sha256').update(JSON.stringify({ command, target, input })).digest('hex')
}

async function transaction<T>(pool: Pool, task: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await task(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export interface RaidService {
  createDraft(
    actorUserId: string,
    kabandaId: string,
    input: CreateRaidInput,
    operationId: string,
  ): Promise<RaidCommandResponse>
  command(
    actorUserId: string,
    raidId: string,
    action: RaidAction,
    input: RaidCommandInput,
    operationId: string,
  ): Promise<RaidCommandResponse>
  reportReadiness(
    actorUserId: string,
    raidId: string,
    input: ReadinessInput,
    operationId: string,
  ): Promise<RaidReadinessResponse>
  acquireNavigatorLease(
    actorUserId: string,
    raidId: string,
    input: NavigatorLeaseInput,
    operationId: string,
  ): Promise<RaidLeaseResponse>
  recoverNavigatorLease(
    actorUserId: string,
    raidId: string,
    input: NavigatorLeaseInput,
    operationId: string,
  ): Promise<RaidLeaseResponse>
  submitRouteBatch(
    actorUserId: string,
    raidId: string,
    input: RouteBatchInput,
    operationId: string,
  ): Promise<RouteBatchResponse>
  getRaid(actorUserId: string, raidId: string): Promise<RaidProjection>
  getCurrent(actorUserId: string): Promise<RaidProjection | null>
  listActionable(actorUserId: string, kabandaId: string): Promise<RaidProjection[]>
}

export class DatabaseRaidService implements RaidService {
  constructor(private readonly pool: Pool) {}

  async createDraft(
    actorUserId: string,
    kabandaId: string,
    input: CreateRaidInput,
    operationId: string,
  ): Promise<RaidCommandResponse> {
    const requestFingerprint = fingerprint('create-raid', kabandaId, input)
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replay<RaidCommandResponse>(
        client,
        actorUserId,
        operationId,
        requestFingerprint,
      )
      if (replay) return replay

      const owner = await client.query(
        `SELECT 1 FROM kabanda_memberships m
         JOIN kabandas k ON k.id = m.kabanda_id AND k.archived_at IS NULL
         WHERE m.kabanda_id = $1 AND m.user_id = $2 AND m.role = 'owner'
           AND m.removed_at IS NULL`,
        [kabandaId, actorUserId],
      )
      if (!owner.rowCount) throw this.notFound()

      const result = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO raids
          (kabanda_id, organizer_user_id, title, description, scheduled_at, state)
         VALUES ($1, $2, $3, $4, $5,
           CASE WHEN $5::timestamptz IS NOT NULL AND $5::timestamptz > now()
             THEN 'planned'::raid_state ELSE 'draft'::raid_state END)
         RETURNING id, created_at`,
        [kabandaId, actorUserId, input.title, input.description ?? null, input.scheduledAt ?? null],
      )
      const raid = result.rows[0]
      if (!raid) throw new Error('Raid create did not return a row')
      await client.query(
        `INSERT INTO raid_participants
          (raid_id, user_id, state, accepted_at)
         VALUES ($1, $2, 'accepted', now())`,
        [raid.id, actorUserId],
      )
      const response = await this.buildResponse(
        client,
        actorUserId,
        raid.id,
        operationId,
        'create-raid',
        raid.created_at,
      )
      await this.storeReceipt(client, {
        actorUserId,
        operationId,
        raidId: raid.id,
        command: 'create-raid',
        requestFingerprint,
        expectedVersion: null,
        fromState: null,
        mutatesState: true,
        response,
      })
      return response
    })
  }

  async command(
    actorUserId: string,
    raidId: string,
    action: RaidAction,
    input: RaidCommandInput,
    operationId: string,
  ): Promise<RaidCommandResponse> {
    const requestFingerprint = fingerprint(action, raidId, input)
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replay<RaidCommandResponse>(
        client,
        actorUserId,
        operationId,
        requestFingerprint,
      )
      if (replay) return replay

      const raid = await this.lockRaid(client, actorUserId, raidId)
      if (raid.version !== input.expectedVersion) {
        throw new RaidError('RAID_VERSION_CONFLICT', 409, 'Рейд уже изменился', {
          currentVersion: raid.version,
          currentState: raid.state,
        })
      }
      if (!isRaidStateTransitionAllowed(raid.state, action)) {
        throw new RaidError('RAID_TRANSITION_INVALID', 409, 'Команда недоступна в текущем состоянии', {
          currentVersion: raid.version,
          currentState: raid.state,
        })
      }

      const fromState = raid.state
      const nextVersion = raid.version + 1
      await this.applyCommand(client, actorUserId, raid, action, input, nextVersion)
      const updated = await client.query<{ updated_at: Date }>(
        `UPDATE raids SET version = $2, updated_at = now() WHERE id = $1 RETURNING updated_at`,
        [raid.id, nextVersion],
      )
      const serverAt = updated.rows[0]?.updated_at
      if (!serverAt) throw new Error('Raid update did not return a row')
      const response = await this.buildResponse(
        client,
        actorUserId,
        raid.id,
        operationId,
        action,
        serverAt,
      )
      await this.storeReceipt(client, {
        actorUserId,
        operationId,
        raidId: raid.id,
        command: action,
        requestFingerprint,
        expectedVersion: input.expectedVersion,
        fromState,
        mutatesState: true,
        response,
      })
      return response
    })
  }

  async reportReadiness(
    actorUserId: string,
    raidId: string,
    input: ReadinessInput,
    operationId: string,
  ): Promise<RaidReadinessResponse> {
    const requestFingerprint = fingerprint('readiness', raidId, input)
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replay<RaidReadinessResponse>(
        client,
        actorUserId,
        operationId,
        requestFingerprint,
      )
      if (replay) return replay

      const raid = await this.lockRaid(client, actorUserId, raidId)
      if (raid.version !== input.expectedVersion) {
        throw new RaidError('RAID_VERSION_CONFLICT', 409, 'Рейд уже изменился', {
          currentVersion: raid.version,
          currentState: raid.state,
        })
      }
      if (raid.state !== 'lobby' || raid.navigator_user_id !== actorUserId) {
        throw this.forbiddenCommand()
      }

      const stored = await this.recordReadiness(client, raid, actorUserId, input)
      const response: RaidReadinessResponse = {
        report: {
          status:
            stored.blocker_codes.length > 0
              ? 'fail'
              : stored.warning_codes.length > 0
                ? 'warn'
                : 'pass',
          blockers: stored.blocker_codes,
          expiresAt: stored.expires_at.toISOString(),
          raidVersion: raid.version,
        },
        raid: await this.project(client, actorUserId, raid.id),
      }
      await this.storeReceipt(client, {
        actorUserId,
        operationId,
        raidId: raid.id,
        command: 'readiness',
        requestFingerprint,
        expectedVersion: input.expectedVersion,
        fromState: raid.state,
        mutatesState: false,
        response,
      })
      return response
    })
  }

  async acquireNavigatorLease(
    actorUserId: string,
    raidId: string,
    input: NavigatorLeaseInput,
    operationId: string,
  ): Promise<RaidLeaseResponse> {
    return this.changeNavigatorLease(actorUserId, raidId, input, operationId, false)
  }

  async recoverNavigatorLease(
    actorUserId: string,
    raidId: string,
    input: NavigatorLeaseInput,
    operationId: string,
  ): Promise<RaidLeaseResponse> {
    return this.changeNavigatorLease(actorUserId, raidId, input, operationId, true)
  }

  private async changeNavigatorLease(
    actorUserId: string,
    raidId: string,
    input: NavigatorLeaseInput,
    operationId: string,
    recover: boolean,
  ): Promise<RaidLeaseResponse> {
    const command = recover ? 'recover-route' : 'acquire-route'
    const requestFingerprint = fingerprint(command, raidId, input)
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replay<RaidLeaseResponse>(
        client,
        actorUserId,
        operationId,
        requestFingerprint,
      )
      if (replay) return replay

      const raid = await this.lockRaid(client, actorUserId, raidId)
      if (raid.version !== input.expectedVersion) {
        throw new RaidError('RAID_VERSION_CONFLICT', 409, 'Рейд уже изменился', {
          currentVersion: raid.version,
          currentState: raid.state,
        })
      }
      this.requireCurrentNavigator(raid, actorUserId)
      const current = await this.lockCurrentLease(client, raid.id)
      let serverAt: Date
      if (recover) {
        if (!current?.client_instance_id) {
          throw new RaidError('NAVIGATOR_LEASE_MISSING', 409, 'Нет lease для восстановления')
        }
        const ended = await client.query<{ ended_at: Date }>(
          `UPDATE raid_navigator_leases SET ended_at = now(), ended_reason = 'recover',
             cutover_sequence = max_accepted_sequence
           WHERE id = $1 RETURNING ended_at`,
          [current.id],
        )
        const endedAt = ended.rows[0]?.ended_at
        if (!endedAt) throw new Error('Recovered lease did not return a cutover time')
        serverAt = endedAt
        await client.query(
          `INSERT INTO raid_navigator_leases
            (raid_id, navigator_user_id, client_instance_id, generation, claimed_at,
             heartbeat_expires_at)
           VALUES ($1, $2, $3, $4, now(), now() + interval '45 seconds')`,
          [raid.id, actorUserId, input.clientInstanceId, current.generation + 1],
        )
      } else {
        if (!current) {
          throw new RaidError('NAVIGATOR_LEASE_MISSING', 409, 'Lease ещё не создан')
        }
        if (current.navigator_user_id !== actorUserId) throw this.forbiddenCommand()
        if (current.client_instance_id && current.client_instance_id !== input.clientInstanceId) {
          throw new RaidError('NAVIGATOR_LEASE_HELD', 409, 'Маршрут пишет другое устройство')
        }
        const claimed = await client.query<{ server_at: Date }>(
          `UPDATE raid_navigator_leases SET client_instance_id = $2,
             claimed_at = coalesce(claimed_at, now()),
             heartbeat_expires_at = now() + interval '45 seconds'
           WHERE id = $1 RETURNING now() AS server_at`,
          [current.id, input.clientInstanceId],
        )
        const claimedAt = claimed.rows[0]?.server_at
        if (!claimedAt) throw new Error('Acquired lease did not return server time')
        serverAt = claimedAt
      }

      const response: RaidLeaseResponse = {
        receipt: { operationId, command, serverAt: serverAt.toISOString() },
        raid: await this.project(client, actorUserId, raid.id),
      }
      await this.storeReceipt(client, {
        actorUserId,
        operationId,
        raidId: raid.id,
        command,
        requestFingerprint,
        expectedVersion: input.expectedVersion,
        fromState: raid.state,
        mutatesState: false,
        response,
      })
      return response
    })
  }

  async submitRouteBatch(
    actorUserId: string,
    raidId: string,
    input: RouteBatchInput,
    operationId: string,
  ): Promise<RouteBatchResponse> {
    const requestFingerprint = fingerprint('route-batch', raidId, input)
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replayRouteBatch(
        client,
        actorUserId,
        operationId,
        requestFingerprint,
      )
      if (replay) return replay

      const raid = await this.lockRaid(client, actorUserId, raidId)
      if (
        raid.state !== 'active' ||
        raid.participant_state !== 'active' ||
        raid.navigator_user_id !== actorUserId
      ) {
        throw new RaidError('NAVIGATOR_LEASE_SUPERSEDED', 409, 'Lease больше не действует')
      }
      const lease = await this.lockCurrentLease(client, raid.id)
      if (
        !lease ||
        lease.id !== input.leaseId ||
        lease.navigator_user_id !== actorUserId ||
        lease.client_instance_id !== input.clientInstanceId
      ) {
        throw new RaidError('NAVIGATOR_LEASE_SUPERSEDED', 409, 'Lease больше не действует')
      }
      if (!lease.claimed_at) {
        throw new RaidError('NAVIGATOR_LEASE_UNCLAIMED', 409, 'Lease ещё не активирован')
      }

      const accepted: RouteBatchResponse['accepted'] = []
      const duplicates: RouteBatchResponse['duplicates'] = []
      const rejected: RouteBatchResponse['rejected'] = []
      let maxAcceptedSequence = Number(lease.max_accepted_sequence)
      const now = Date.now()
      for (const sample of input.samples) {
        const sampleFingerprint = fingerprint('route-sample', raid.id, sample)
        const capturedAt = new Date(sample.capturedAt)
        if (
          capturedAt.getTime() < lease.claimed_at.getTime() - 5_000 ||
          capturedAt.getTime() > now + 30_000
        ) {
          rejected.push({ operationId: sample.operationId, code: 'SAMPLE_OUTSIDE_LEASE' })
          continue
        }
        const existing = await client.query<{
          operation_id: string
          sequence: string
          payload_hash: string
        }>(
          `SELECT operation_id, sequence, payload_hash FROM raid_route_samples
           WHERE (lease_id = $1 AND sequence = $2)
              OR (raid_id = $3 AND operation_id = $4)
           LIMIT 1`,
          [lease.id, sample.sequence, raid.id, sample.operationId],
        )
        const stored = existing.rows[0]
        if (stored) {
          if (
            stored.operation_id !== sample.operationId ||
            Number(stored.sequence) !== sample.sequence ||
            stored.payload_hash !== sampleFingerprint
          ) {
            throw new RaidError(
              'ROUTE_SAMPLE_CONFLICT',
              409,
              'Номер или operationId образца уже использован',
            )
          }
          duplicates.push({ operationId: sample.operationId })
          continue
        }
        const inserted = await client.query<{ received_at: Date }>(
          `INSERT INTO raid_route_samples
            (raid_id, lease_id, operation_id, sequence, captured_at, geom, accuracy_m,
             speed_mps, heading_deg, payload_hash)
           VALUES ($1, $2, $3, $4, $5,
             ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography,
             $8, $9, $10, $11)
           RETURNING received_at`,
          [
            raid.id,
            lease.id,
            sample.operationId,
            sample.sequence,
            sample.capturedAt,
            sample.longitude,
            sample.latitude,
            sample.accuracyM,
            sample.speedMps ?? null,
            sample.headingDeg ?? null,
            sampleFingerprint,
          ],
        )
        const receivedAt = inserted.rows[0]?.received_at
        if (!receivedAt) throw new Error('Route sample insert did not return a row')
        accepted.push({ operationId: sample.operationId, acceptedAt: receivedAt.toISOString() })
        maxAcceptedSequence = Math.max(maxAcceptedSequence, sample.sequence)
      }

      const heartbeat = await client.query<{ server_at: Date }>(
        `UPDATE raid_navigator_leases SET
           heartbeat_expires_at = now() + interval '45 seconds',
           max_accepted_sequence = greatest(max_accepted_sequence, $2),
           accepted_sample_count = accepted_sample_count + $3
         WHERE id = $1 RETURNING now() AS server_at`,
        [lease.id, maxAcceptedSequence, accepted.length],
      )
      const serverAt = heartbeat.rows[0]?.server_at
      if (!serverAt) throw new Error('Lease heartbeat did not return a row')
      const response: RouteBatchResponse = {
        batchId: operationId,
        accepted,
        duplicates,
        rejected,
        routeStatus: await this.routeStatus(client, raid),
        serverAt: serverAt.toISOString(),
      }
      await this.storeRouteBatchReceipt(client, {
        actorUserId,
        operationId,
        raidId: raid.id,
        leaseId: lease.id,
        requestFingerprint,
        response,
      })
      return response
    })
  }

  async getRaid(actorUserId: string, raidId: string): Promise<RaidProjection> {
    const client = await this.pool.connect()
    try {
      await this.visibleRaid(client, actorUserId, raidId)
      return this.project(client, actorUserId, raidId)
    } finally {
      client.release()
    }
  }

  async getCurrent(actorUserId: string): Promise<RaidProjection | null> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT r.id FROM raids r
       JOIN kabanda_memberships m
         ON m.kabanda_id = r.kabanda_id AND m.user_id = $1 AND m.removed_at IS NULL
       LEFT JOIN raid_participants p ON p.raid_id = r.id AND p.user_id = $1
       WHERE r.state IN ('active', 'paused', 'finalizing')
         AND (m.role = 'owner' OR p.state = 'active')
       ORDER BY r.updated_at DESC, r.id LIMIT 2`,
      [actorUserId],
    )
    if (result.rows.length > 1) {
      throw new RaidError(
        'RAID_CURRENT_AMBIGUOUS',
        409,
        'Найдено несколько активных рейдов; выберите Кабанду',
      )
    }
    return result.rows[0] ? this.getRaid(actorUserId, result.rows[0].id) : null
  }

  async listActionable(actorUserId: string, kabandaId: string): Promise<RaidProjection[]> {
    const visible = await this.pool.query<{ role: 'owner' | 'member' }>(
      `SELECT m.role FROM kabanda_memberships m
       JOIN kabandas k ON k.id = m.kabanda_id AND k.archived_at IS NULL
       WHERE m.kabanda_id = $1 AND m.user_id = $2 AND m.removed_at IS NULL`,
      [kabandaId, actorUserId],
    )
    if (!visible.rows[0]) throw this.notFound()
    const ids = await this.pool.query<{ id: string }>(
      `SELECT r.id FROM raids r
       LEFT JOIN raid_participants p ON p.raid_id = r.id AND p.user_id = $2
       WHERE r.kabanda_id = $1
         AND r.state IN ('draft', 'planned', 'lobby', 'active', 'paused', 'finalizing')
         AND ($3::text = 'owner' OR p.state IN ('invited', 'accepted', 'ready', 'active'))
       ORDER BY CASE r.state
         WHEN 'active' THEN 1 WHEN 'paused' THEN 2 WHEN 'finalizing' THEN 3
         WHEN 'lobby' THEN 4 WHEN 'planned' THEN 5 ELSE 6 END,
         r.scheduled_at ASC NULLS LAST, r.created_at DESC, r.id
       LIMIT 20`,
      [kabandaId, actorUserId, visible.rows[0].role],
    )
    return Promise.all(ids.rows.map(({ id }) => this.getRaid(actorUserId, id)))
  }

  private async applyCommand(
    client: PoolClient,
    actorUserId: string,
    raid: RaidRow,
    action: RaidAction,
    input: RaidCommandInput,
    nextVersion: number,
  ): Promise<void> {
    switch (action) {
      case 'open-lobby':
        this.requireOrganizer(raid, actorUserId)
        await client.query(
          `INSERT INTO raid_participants (raid_id, user_id, state, accepted_at)
           SELECT $1, m.user_id,
             CASE WHEN m.user_id = $2 THEN 'accepted'::raid_participant_state
                  ELSE 'invited'::raid_participant_state END,
             CASE WHEN m.user_id = $2 THEN now() ELSE NULL END
           FROM kabanda_memberships m
           WHERE m.kabanda_id = $3 AND m.removed_at IS NULL
           ON CONFLICT (raid_id, user_id) DO NOTHING`,
          [raid.id, actorUserId, raid.kabanda_id],
        )
        await client.query(`UPDATE raids SET state = 'lobby' WHERE id = $1`, [raid.id])
        return
      case 'accept':
      case 'decline': {
        if (raid.participant_state !== 'invited') throw this.forbiddenCommand()
        const state = action === 'accept' ? 'accepted' : 'declined'
        await client.query(
          `UPDATE raid_participants SET state = $3::raid_participant_state,
             accepted_at = CASE
               WHEN $3::raid_participant_state = 'accepted'::raid_participant_state
               THEN now() ELSE accepted_at END,
             updated_at = now()
           WHERE raid_id = $1 AND user_id = $2`,
          [raid.id, actorUserId, state],
        )
        return
      }
      case 'ready':
        if (raid.participant_state !== 'accepted') throw this.forbiddenCommand()
        await client.query(
          `UPDATE raid_participants SET state = 'ready', ready_at = now(), updated_at = now()
           WHERE raid_id = $1 AND user_id = $2`,
          [raid.id, actorUserId],
        )
        return
      case 'assign-navigator': {
        this.requireOrganizer(raid, actorUserId)
        if (!input.navigatorUserId) {
          throw new RaidError('NAVIGATOR_REQUIRED', 400, 'Выберите навигатора')
        }
        const candidate = await client.query<{ state: RaidParticipantState }>(
          `SELECT p.state FROM raid_participants p
           JOIN kabanda_memberships m
             ON m.kabanda_id = $3 AND m.user_id = p.user_id AND m.removed_at IS NULL
           WHERE p.raid_id = $1 AND p.user_id = $2 AND p.state IN ('accepted', 'ready')`,
          [raid.id, input.navigatorUserId, raid.kabanda_id],
        )
        if (!candidate.rows[0]) throw this.notFound()
        await client.query(
          `UPDATE raid_participants SET state = 'accepted', ready_at = NULL, updated_at = now()
           WHERE raid_id = $1 AND user_id = $2`,
          [raid.id, input.navigatorUserId],
        )
        await client.query('UPDATE raids SET navigator_user_id = $2 WHERE id = $1', [
          raid.id,
          input.navigatorUserId,
        ])
        return
      }
      case 'handoff-navigator': {
        this.requireOrganizer(raid, actorUserId)
        if (!input.navigatorUserId) {
          throw new RaidError('NAVIGATOR_REQUIRED', 400, 'Выберите навигатора')
        }
        const candidate = await client.query(
          `SELECT 1 FROM raid_participants p
           JOIN kabanda_memberships m
             ON m.kabanda_id = $3 AND m.user_id = p.user_id AND m.removed_at IS NULL
           WHERE p.raid_id = $1 AND p.user_id = $2 AND p.state = 'active'
           FOR UPDATE OF p, m`,
          [raid.id, input.navigatorUserId, raid.kabanda_id],
        )
        if (!candidate.rowCount) throw this.notFound()
        await this.closeCurrentLease(client, raid.id, 'handoff')
        await client.query('UPDATE raids SET navigator_user_id = $2 WHERE id = $1', [
          raid.id,
          input.navigatorUserId,
        ])
        if (raid.state === 'active') {
          await this.createUnclaimedLease(client, raid.id, input.navigatorUserId)
        }
        return
      }
      case 'start': {
        this.requireOrganizer(raid, actorUserId)
        const readiness = await this.currentReadiness(client, raid.id, raid.navigator_user_id, raid.version)
        if (!readiness || readiness.blocker_codes.length > 0) {
          throw new RaidError('NAVIGATOR_NOT_READY', 409, 'Навигатор ещё не готов', {
            blockers: readiness?.blocker_codes ?? ['NAVIGATOR_NOT_ASSIGNED'],
          })
        }
        const navigator = await client.query(
          `SELECT 1 FROM raid_participants p
           JOIN kabanda_memberships m
             ON m.kabanda_id = $3 AND m.user_id = p.user_id AND m.removed_at IS NULL
           WHERE p.raid_id = $1 AND p.user_id = $2 AND p.state = 'ready'`,
          [raid.id, raid.navigator_user_id, raid.kabanda_id],
        )
        if (!navigator.rowCount) throw this.forbiddenCommand()
        await client.query(
          `UPDATE raid_participants SET state = 'active', active_from = now(), updated_at = now()
           WHERE raid_id = $1 AND state IN ('accepted', 'ready')`,
          [raid.id],
        )
        try {
          await client.query(`UPDATE raids SET state = 'active', started_at = now() WHERE id = $1`, [
            raid.id,
          ])
        } catch (error) {
          if ((error as { constraint?: string }).constraint === 'raids_one_active_per_kabanda_idx') {
            throw new RaidError('ACTIVE_RAID_EXISTS', 409, 'У Кабанды уже есть активный рейд')
          }
          throw error
        }
        await this.openActivityWindow(client, raid.id, nextVersion)
        if (!raid.navigator_user_id) throw this.forbiddenCommand()
        await this.createUnclaimedLease(client, raid.id, raid.navigator_user_id)
        return
      }
      case 'pause':
        this.requireOrganizer(raid, actorUserId)
        await this.closeActivityWindow(client, raid.id, nextVersion)
        await this.closeCurrentLease(client, raid.id, 'pause')
        await client.query(`UPDATE raids SET state = 'paused', paused_at = now() WHERE id = $1`, [raid.id])
        return
      case 'resume':
        this.requireOrganizer(raid, actorUserId)
        await client.query(`UPDATE raids SET state = 'active', paused_at = NULL WHERE id = $1`, [raid.id])
        await this.openActivityWindow(client, raid.id, nextVersion)
        if (!raid.navigator_user_id) throw this.forbiddenCommand()
        await this.createUnclaimedLease(client, raid.id, raid.navigator_user_id)
        return
      case 'cancel':
        this.requireOrganizer(raid, actorUserId)
        await this.closeActivityWindow(client, raid.id, nextVersion)
        await this.closeCurrentLease(client, raid.id, 'cancel')
        await client.query(`UPDATE raids SET state = 'cancelled', cancelled_at = now() WHERE id = $1`, [
          raid.id,
        ])
        return
    }
  }

  private async recordReadiness(
    client: PoolClient,
    raid: RaidRow,
    actorUserId: string,
    input: ReadinessInput,
  ): Promise<StoredReadinessRow> {
    const now = Date.now()
    const coordinateAge = input.coordinateMeasuredAt
      ? now - new Date(input.coordinateMeasuredAt).getTime()
      : null
    const measuredAge = now - new Date(input.measuredAt).getTime()
    const blockers: string[] = []
    const warnings: string[] = ['BACKGROUND_GPS_UNVERIFIED']
    if (!input.online) blockers.push('OFFLINE')
    if (input.locationPermission !== 'granted') blockers.push('LOCATION_PERMISSION')
    if (coordinateAge === null || coordinateAge < -5_000 || coordinateAge > 30_000) {
      blockers.push('LOCATION_STALE')
    }
    if (input.accuracyM === null || input.accuracyM > 100) {
      blockers.push('LOCATION_INACCURATE')
    }
    if (!input.indexedDbWritable) blockers.push('INDEXED_DB_UNAVAILABLE')
    if (input.storageAvailable === false) blockers.push('STORAGE_UNAVAILABLE')
    if (input.storageAvailable === null) warnings.push('STORAGE_UNKNOWN')
    if (measuredAge < -5_000 || measuredAge > 120_000) blockers.push('REPORT_STALE')
    if (input.appMode === 'browser') warnings.push('STANDALONE_NOT_CONFIRMED')
    const result = await client.query<StoredReadinessRow>(
      `INSERT INTO raid_readiness_reports
        (raid_id, navigator_user_id, raid_version, app_mode, location_permission,
         coordinate_measured_at, accuracy_meters, indexed_db_writable, storage_available,
         online, measured_at, blocker_codes, warning_codes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         now() + interval '2 minutes')
       RETURNING blocker_codes, warning_codes, expires_at`,
      [
        raid.id,
        actorUserId,
        raid.version,
        input.appMode,
        input.locationPermission,
        input.coordinateMeasuredAt,
        input.accuracyM,
        input.indexedDbWritable,
        input.storageAvailable,
        input.online,
        input.measuredAt,
        blockers,
        warnings,
      ],
    )
    const stored = result.rows[0]
    if (!stored) throw new Error('Readiness insert did not return a row')
    return stored
  }

  private async currentReadiness(
    client: PoolClient,
    raidId: string,
    navigatorUserId: string | null,
    raidVersion: number,
  ): Promise<ReadinessRow | null> {
    if (!navigatorUserId) return null
    const result = await client.query<ReadinessRow>(
      `SELECT blocker_codes, warning_codes FROM raid_readiness_reports
       WHERE raid_id = $1 AND navigator_user_id = $2 AND raid_version = $3
         AND expires_at > now()
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [raidId, navigatorUserId, raidVersion],
    )
    return result.rows[0] ?? null
  }

  private async lockCurrentLease(client: PoolClient, raidId: string): Promise<LeaseRow | null> {
    const result = await client.query<LeaseRow>(
      `SELECT id, navigator_user_id, client_instance_id, generation, issued_at, claimed_at,
         heartbeat_expires_at, ended_at, max_accepted_sequence, accepted_sample_count
       FROM raid_navigator_leases
       WHERE raid_id = $1 AND ended_at IS NULL
       FOR UPDATE`,
      [raidId],
    )
    return result.rows[0] ?? null
  }

  private async createUnclaimedLease(
    client: PoolClient,
    raidId: string,
    navigatorUserId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO raid_navigator_leases (raid_id, navigator_user_id, generation)
       SELECT $1, $2, coalesce(max(generation), 0) + 1
       FROM raid_navigator_leases WHERE raid_id = $1`,
      [raidId, navigatorUserId],
    )
  }

  private async closeCurrentLease(
    client: PoolClient,
    raidId: string,
    reason: 'pause' | 'cancel' | 'handoff' | 'recover',
  ): Promise<void> {
    await client.query(
      `UPDATE raid_navigator_leases SET ended_at = now(), ended_reason = $2,
         cutover_sequence = max_accepted_sequence
       WHERE raid_id = $1 AND ended_at IS NULL`,
      [raidId, reason],
    )
  }

  private async openActivityWindow(
    client: PoolClient,
    raidId: string,
    openedVersion: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO raid_activity_windows (raid_id, opened_at, opened_version)
       VALUES ($1, now(), $2)`,
      [raidId, openedVersion],
    )
  }

  private async closeActivityWindow(
    client: PoolClient,
    raidId: string,
    closedVersion: number,
  ): Promise<void> {
    await client.query(
      `UPDATE raid_activity_windows SET closed_at = now(), closed_version = $2
       WHERE raid_id = $1 AND closed_at IS NULL`,
      [raidId, closedVersion],
    )
  }

  private requireCurrentNavigator(raid: RaidRow, actorUserId: string): void {
    if (
      raid.state !== 'active' ||
      raid.navigator_user_id !== actorUserId ||
      raid.participant_state !== 'active'
    ) {
      throw this.forbiddenCommand()
    }
  }

  private async routeStatus(client: PoolClient, raid: RaidRow): Promise<RouteStatusProjection> {
    const leaseResult = await client.query<LeaseRow>(
      `SELECT id, navigator_user_id, client_instance_id, generation, issued_at, claimed_at,
         heartbeat_expires_at, ended_at, max_accepted_sequence, accepted_sample_count
       FROM raid_navigator_leases
       WHERE raid_id = $1 AND ended_at IS NULL`,
      [raid.id],
    )
    const sampleResult = await client.query<{
      last_sample_at: Date | null
      last_received_at: Date | null
      accepted_count: string
      missing_count: string
    }>(
      `SELECT
         (SELECT max(captured_at) FROM raid_route_samples
          WHERE lease_id = (SELECT id FROM raid_navigator_leases
            WHERE raid_id = $1 AND ended_at IS NULL)) AS last_sample_at,
         (SELECT max(received_at) FROM raid_route_samples
          WHERE lease_id = (SELECT id FROM raid_navigator_leases
            WHERE raid_id = $1 AND ended_at IS NULL)) AS last_received_at,
         (SELECT count(*)::text FROM raid_route_samples WHERE raid_id = $1) AS accepted_count,
         (SELECT coalesce(sum(max_accepted_sequence - accepted_sample_count), 0)::text
          FROM raid_navigator_leases WHERE raid_id = $1) AS missing_count`,
      [raid.id],
    )
    const lease = leaseResult.rows[0] ?? null
    const samples = sampleResult.rows[0]
    const lastSampleAt = samples?.last_sample_at ?? null
    const sampleAgeSeconds = lastSampleAt
      ? Math.max(0, (Date.now() - lastSampleAt.getTime()) / 1000)
      : null
    return {
      status: getRouteStatusCode({
        raidState: raid.state,
        leaseClaimed: Boolean(lease?.client_instance_id),
        leaseHeartbeatFresh: Boolean(
          lease?.heartbeat_expires_at && lease.heartbeat_expires_at.getTime() > Date.now(),
        ),
        sampleAgeSeconds,
      }),
      navigatorUserId: raid.navigator_user_id,
      generation: lease?.generation ?? null,
      lastSampleAt: lastSampleAt?.toISOString() ?? null,
      lastReceivedAt: samples?.last_received_at?.toISOString() ?? null,
      acceptedSampleCount: Number(samples?.accepted_count ?? 0),
      missingSequenceCount: Number(samples?.missing_count ?? 0),
    }
  }

  private async navigatorLeaseProjection(
    client: PoolClient,
    raid: RaidRow,
    actorUserId: string,
  ): Promise<NavigatorLeaseProjection | null> {
    if (raid.navigator_user_id !== actorUserId) return null
    const result = await client.query<{ id: string; generation: number; issued_at: Date }>(
      `SELECT id, generation, issued_at FROM raid_navigator_leases
       WHERE raid_id = $1 AND navigator_user_id = $2 AND ended_at IS NULL`,
      [raid.id, actorUserId],
    )
    const lease = result.rows[0]
    return lease
      ? { id: lease.id, generation: lease.generation, issuedAt: lease.issued_at.toISOString() }
      : null
  }

  private async lockRaid(client: PoolClient, actorUserId: string, raidId: string): Promise<RaidRow> {
    const result = await client.query<RaidRow>(
      `SELECT r.id, r.kabanda_id, r.organizer_user_id, r.navigator_user_id,
         r.title, r.description, r.scheduled_at, r.state, r.version,
         m.role AS membership_role, p.state AS participant_state
       FROM raids r
       JOIN kabandas k ON k.id = r.kabanda_id AND k.archived_at IS NULL
       JOIN kabanda_memberships m
         ON m.kabanda_id = r.kabanda_id AND m.user_id = $2 AND m.removed_at IS NULL
       LEFT JOIN raid_participants p ON p.raid_id = r.id AND p.user_id = $2
       WHERE r.id = $1 FOR UPDATE OF r, m`,
      [raidId, actorUserId],
    )
    const raid = result.rows[0]
    if (!raid) throw this.notFound()
    if (
      raid.membership_role !== 'owner' &&
      (!raid.participant_state || !visibleParticipantStates.includes(raid.participant_state))
    ) {
      throw this.notFound()
    }
    return raid
  }

  private async visibleRaid(client: PoolClient, actorUserId: string, raidId: string): Promise<void> {
    const result = await client.query<{ role: 'owner' | 'member'; participant_state: RaidParticipantState | null }>(
      `SELECT m.role, p.state AS participant_state FROM raids r
       JOIN kabandas k ON k.id = r.kabanda_id AND k.archived_at IS NULL
       JOIN kabanda_memberships m
         ON m.kabanda_id = r.kabanda_id AND m.user_id = $2 AND m.removed_at IS NULL
       LEFT JOIN raid_participants p ON p.raid_id = r.id AND p.user_id = $2
       WHERE r.id = $1`,
      [raidId, actorUserId],
    )
    const access = result.rows[0]
    if (
      !access ||
      (access.role !== 'owner' &&
        (!access.participant_state || !visibleParticipantStates.includes(access.participant_state)))
    ) {
      throw this.notFound()
    }
  }

  private async project(
    client: PoolClient,
    actorUserId: string,
    raidId: string,
  ): Promise<RaidProjection> {
    const raidResult = await client.query<RaidRow>(
      `SELECT r.id, r.kabanda_id, r.organizer_user_id, r.navigator_user_id,
         r.title, r.description, r.scheduled_at, r.state, r.version,
         m.role AS membership_role, p.state AS participant_state
       FROM raids r
       JOIN kabanda_memberships m
         ON m.kabanda_id = r.kabanda_id AND m.user_id = $2 AND m.removed_at IS NULL
       LEFT JOIN raid_participants p ON p.raid_id = r.id AND p.user_id = $2
       WHERE r.id = $1`,
      [raidId, actorUserId],
    )
    const raid = raidResult.rows[0]
    if (!raid) throw this.notFound()
    const participants = await client.query<{
      id: string
      display_name: string
      avatar_url: string | null
      state: RaidParticipantState
    }>(
      `SELECT u.id, coalesce(u.display_name, split_part(u.email::text, '@', 1)) AS display_name,
         u.avatar_url, p.state
       FROM raid_participants p JOIN users u ON u.id = p.user_id
       WHERE p.raid_id = $1 ORDER BY p.invited_at, p.user_id`,
      [raidId],
    )
    const readiness = await this.currentReadiness(
      client,
      raid.id,
      raid.navigator_user_id,
      raid.version,
    )
    const navigatorParticipantReady = participants.rows.some(
      (participant) => participant.id === raid.navigator_user_id && participant.state === 'ready',
    )
    const navigatorReady = Boolean(
      navigatorParticipantReady && readiness && readiness.blocker_codes.length === 0,
    )
    const routeStatus = await this.routeStatus(client, raid)
    const navigatorLease = await this.navigatorLeaseProjection(client, raid, actorUserId)
    return {
      id: raid.id,
      kabandaId: raid.kabanda_id,
      title: raid.title,
      description: raid.description,
      scheduledAt: raid.scheduled_at?.toISOString() ?? null,
      state: raid.state,
      version: Number(raid.version),
      organizerUserId: raid.organizer_user_id,
      navigatorUserId: raid.navigator_user_id,
      navigatorReady,
      navigatorBlockers: readiness?.blocker_codes ?? [],
      navigatorWarnings: readiness?.warning_codes ?? [],
      routeStatus,
      navigatorLease,
      participants: participants.rows.map((participant) => ({
        id: participant.id,
        displayName: participant.display_name,
        avatarUrl: participant.avatar_url,
        state: participant.state,
      })),
      allowedActions: getRaidAllowedActions({
        state: raid.state,
        role: raid.membership_role,
        participantState: raid.participant_state,
        navigatorReady,
      }),
    }
  }

  private async buildResponse(
    client: PoolClient,
    actorUserId: string,
    raidId: string,
    operationId: string,
    command: string,
    serverAt: Date,
  ): Promise<RaidCommandResponse> {
    const raid = await this.project(client, actorUserId, raidId)
    return {
      receipt: {
        operationId,
        command,
        resultingVersion: raid.version,
        serverAt: serverAt.toISOString(),
      },
      raid,
    }
  }

  private async storeReceipt(
    client: PoolClient,
    input: {
      actorUserId: string
      operationId: string
      raidId: string
      command: string
      requestFingerprint: string
      expectedVersion: number | null
      fromState: RaidState | null
      mutatesState: boolean
      response: RaidCommandResponse | RaidReadinessResponse | RaidLeaseResponse
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO raid_command_receipts
        (actor_user_id, operation_id, raid_id, command, request_fingerprint,
         expected_version, mutates_state, from_state, resulting_state, resulting_version,
         response_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.actorUserId,
        input.operationId,
        input.raidId,
        input.command,
        input.requestFingerprint,
        input.expectedVersion,
        input.mutatesState,
        input.fromState,
        input.response.raid.state,
        input.response.raid.version,
        input.response,
      ],
    )
  }

  private async lockOperation(
    client: PoolClient,
    actorUserId: string,
    operationId: string,
  ): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${actorUserId}:${operationId}`,
    ])
  }

  private async storeRouteBatchReceipt(
    client: PoolClient,
    input: {
      actorUserId: string
      operationId: string
      raidId: string
      leaseId: string
      requestFingerprint: string
      response: RouteBatchResponse
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO raid_route_batch_receipts
        (id, actor_user_id, operation_id, raid_id, lease_id, request_fingerprint,
         response_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        input.actorUserId,
        input.operationId,
        input.raidId,
        input.leaseId,
        input.requestFingerprint,
        input.response,
      ],
    )
  }

  private async replayRouteBatch(
    client: PoolClient,
    actorUserId: string,
    operationId: string,
    requestFingerprint: string,
  ): Promise<RouteBatchResponse | null> {
    const result = await client.query<{
      request_fingerprint: string
      response_json: RouteBatchResponse
      access_active: boolean
    }>(
      `SELECT b.request_fingerprint, b.response_json,
         (k.archived_at IS NULL AND m.user_id IS NOT NULL) AS access_active
       FROM raid_route_batch_receipts b
       JOIN raids r ON r.id = b.raid_id
       JOIN kabandas k ON k.id = r.kabanda_id
       LEFT JOIN kabanda_memberships m
         ON m.kabanda_id = r.kabanda_id AND m.user_id = b.actor_user_id
           AND m.removed_at IS NULL
       WHERE b.actor_user_id = $1 AND b.operation_id = $2`,
      [actorUserId, operationId],
    )
    const receipt = result.rows[0]
    if (!receipt) {
      const other = await client.query<{ access_active: boolean }>(
        `SELECT (k.archived_at IS NULL AND m.user_id IS NOT NULL) AS access_active
         FROM raid_command_receipts rc
         JOIN raids r ON r.id = rc.raid_id
         JOIN kabandas k ON k.id = r.kabanda_id
         LEFT JOIN kabanda_memberships m
           ON m.kabanda_id = r.kabanda_id AND m.user_id = rc.actor_user_id
             AND m.removed_at IS NULL
         WHERE rc.actor_user_id = $1 AND rc.operation_id = $2`,
        [actorUserId, operationId],
      )
      const conflicting = other.rows[0]
      if (!conflicting) return null
      if (!conflicting.access_active) throw this.notFound()
      throw new RaidError('IDEMPOTENCY_CONFLICT', 409, 'Ключ уже использован для другой команды')
    }
    if (!receipt.access_active) throw this.notFound()
    if (receipt.request_fingerprint !== requestFingerprint) {
      throw new RaidError('IDEMPOTENCY_CONFLICT', 409, 'Ключ уже использован для другого batch')
    }
    return receipt.response_json
  }

  private async replay<T>(
    client: PoolClient,
    actorUserId: string,
    operationId: string,
    requestFingerprint: string,
  ): Promise<T | null> {
    const result = await client.query<{
      request_fingerprint: string
      response_json: T
      access_active: boolean
    }>(
      `SELECT rc.request_fingerprint, rc.response_json,
         (k.archived_at IS NULL AND m.user_id IS NOT NULL) AS access_active
       FROM raid_command_receipts rc
       JOIN raids r ON r.id = rc.raid_id
       JOIN kabandas k ON k.id = r.kabanda_id
       LEFT JOIN kabanda_memberships m
         ON m.kabanda_id = r.kabanda_id AND m.user_id = rc.actor_user_id
           AND m.removed_at IS NULL
       WHERE rc.actor_user_id = $1 AND rc.operation_id = $2`,
      [actorUserId, operationId],
    )
    const receipt = result.rows[0]
    if (!receipt) {
      const other = await client.query<{ access_active: boolean }>(
        `SELECT (k.archived_at IS NULL AND m.user_id IS NOT NULL) AS access_active
         FROM raid_route_batch_receipts b
         JOIN raids r ON r.id = b.raid_id
         JOIN kabandas k ON k.id = r.kabanda_id
         LEFT JOIN kabanda_memberships m
           ON m.kabanda_id = r.kabanda_id AND m.user_id = b.actor_user_id
             AND m.removed_at IS NULL
         WHERE b.actor_user_id = $1 AND b.operation_id = $2`,
        [actorUserId, operationId],
      )
      const conflicting = other.rows[0]
      if (!conflicting) return null
      if (!conflicting.access_active) throw this.notFound()
      throw new RaidError('IDEMPOTENCY_CONFLICT', 409, 'Ключ уже использован для route batch')
    }
    if (!receipt.access_active) throw this.notFound()
    if (receipt.request_fingerprint !== requestFingerprint) {
      throw new RaidError('IDEMPOTENCY_CONFLICT', 409, 'Ключ уже использован для другой команды')
    }
    return receipt.response_json
  }

  private requireOrganizer(raid: RaidRow, actorUserId: string): void {
    if (raid.membership_role !== 'owner' || raid.organizer_user_id !== actorUserId) {
      throw this.forbiddenCommand()
    }
  }

  private forbiddenCommand(): RaidError {
    return new RaidError('RAID_COMMAND_FORBIDDEN', 403, 'Недостаточно прав для команды')
  }

  private notFound(): RaidError {
    return new RaidError('RAID_NOT_FOUND', 404, 'Рейд не найден')
  }
}
