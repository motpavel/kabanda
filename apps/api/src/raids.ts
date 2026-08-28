import { createHash } from 'node:crypto'
import {
  getRaidAllowedActions,
  isRaidStateTransitionAllowed,
  type RaidAction,
  type RaidParticipantState,
  type RaidState,
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
      await this.applyCommand(client, actorUserId, raid, action, input)
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
        return
      }
      case 'pause':
        this.requireOrganizer(raid, actorUserId)
        await client.query(`UPDATE raids SET state = 'paused', paused_at = now() WHERE id = $1`, [raid.id])
        return
      case 'resume':
        this.requireOrganizer(raid, actorUserId)
        await client.query(`UPDATE raids SET state = 'active', paused_at = NULL WHERE id = $1`, [raid.id])
        return
      case 'cancel':
        this.requireOrganizer(raid, actorUserId)
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
       WHERE r.id = $1 FOR UPDATE OF r`,
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
      response: RaidCommandResponse | RaidReadinessResponse
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
    if (!receipt) return null
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
