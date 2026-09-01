import { createHash, createHmac, randomUUID } from 'node:crypto'
import sharp, { type Metadata, type Sharp } from 'sharp'
import {
  getRaidAllowedActions,
  getRouteStatusCode,
  isRaidStateTransitionAllowed,
  type RaidAction,
  type RaidParticipantState,
  type RaidState,
  type RouteStatusCode,
} from '@kabanda/domain'
import type { Pool, PoolClient, QueryResult } from 'pg'

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

export function deriveMediaUploadCapability(
  secret: string,
  raidId: string,
  intentId: string,
  actorUserId: string,
): string {
  return createHmac('sha256', secret)
    .update(`raid-media-upload:v1:${raidId}:${intentId}:${actorUserId}`)
    .digest('base64url')
}

export function escapeShareCardXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export async function renderRaidShareCard(result: RaidResult): Promise<Buffer> {
  const title = escapeShareCardXml(result.raid.title.slice(0, 120))
  const date = escapeShareCardXml(result.raid.completedAt.slice(0, 10))
  const distanceKm = (result.team.distanceMeters / 1000).toFixed(1)
  const durationMinutes = Math.round(result.team.durationSeconds / 60)
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <rect width="1200" height="630" fill="#1a1410"/>
    <rect x="42" y="42" width="1116" height="546" rx="34" fill="#f4e9d4"/>
    <text x="92" y="126" font-family="DejaVu Sans, sans-serif" font-size="46" font-weight="700" fill="#3b2c22">KABANDA</text>
    <text x="92" y="202" font-family="DejaVu Sans, sans-serif" font-size="42" font-weight="700" fill="#245d3b">${title}</text>
    <text x="92" y="254" font-family="DejaVu Sans, sans-serif" font-size="25" fill="#795c3f">${date}</text>
    <text x="92" y="366" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#795c3f">DISTANCE</text>
    <text x="92" y="428" font-family="DejaVu Sans, sans-serif" font-size="48" font-weight="700" fill="#245d3b">${distanceKm} km</text>
    <text x="390" y="366" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#795c3f">TIME</text>
    <text x="390" y="428" font-family="DejaVu Sans, sans-serif" font-size="48" font-weight="700" fill="#245d3b">${durationMinutes} min</text>
    <text x="680" y="366" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#795c3f">POINTS</text>
    <text x="680" y="428" font-family="DejaVu Sans, sans-serif" font-size="48" font-weight="700" fill="#245d3b">${result.team.uniquePoints}</text>
    <text x="940" y="366" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#795c3f">TEAM</text>
    <text x="940" y="428" font-family="DejaVu Sans, sans-serif" font-size="48" font-weight="700" fill="#245d3b">${result.participants.length}</text>
  </svg>`)
  return sharp(svg, { density: 144 })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer()
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

export type RaidCommandAction = Exclude<
  RaidAction,
  'finish' | 'leave' | 'settle-finalization'
>

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

export type RaidPendingCounts = { claims: number; fallbacks: number; media: number }
export type RaidFinalizationProjection = {
  status: 'collecting'
  partial: boolean
  pendingCounts: RaidPendingCounts
  deadlineAt: string
  canSettle: boolean
}

export type RaidMetrics = {
  durationSeconds: number
  distanceMeters: number
  uniquePoints: number
  photos: number
}

export type RaidResult = {
  schemaVersion: 1
  raid: {
    id: string
    kabandaId: string
    title: string
    startedAt: string
    completedAt: string
    partial: boolean
  }
  team: RaidMetrics
  personal: RaidMetrics
  participants: Array<{ userId: string; displayName: string; metrics: RaidMetrics }>
}

export type FinishRaidInput = {
  expectedVersion: number
  inventory: {
    routePending: number
    checkInsPending: number
    mediaPending: number
    needsAction: number
  }
  confirmPartial: boolean
}

export type FinishRaidResponse = {
  raid: RaidProjection
  finalization: RaidFinalizationProjection
}

export type SettleRaidResponse = { raid: RaidProjection; result: RaidResult }

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
  finalization: RaidFinalizationProjection | null
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

export type NearbyCheckinInput = { latitude: number; longitude: number; limit: number }
export type CheckinInput = {
  pointSnapshotId: string
  evidence: { latitude: number; longitude: number; capturedAt: string; accuracyMeters: number }
  presentParticipantIds: string[]
  organizerAttestation: boolean
}
export type CreditProjection = {
  id: string
  userId: string
  pointSnapshotId: string
  source: 'gps' | 'organizer_attestation' | 'claim' | 'media_fallback'
  creditedAt: string
}
export type ClaimProjection = {
  id: string
  attemptId: string
  userId: string
  status: 'pending' | 'confirmed' | 'declined' | 'expired'
  expiresAt: string
}
export type CheckinResponse = {
  operationId: string
  attemptId: string
  outcome: 'accepted' | 'needs_manual_verification'
  reason: null | 'location_expired' | 'accuracy_insufficient' | 'too_far'
  point: { pointSnapshotId: string; sourcePointId: string; name: string }
  distanceMeters?: number
  credits: CreditProjection[]
  claims: ClaimProjection[]
}
export type FallbackProjection = {
  id: string
  attemptId: string
  mediaId: string
  verifierUserId: string
  status: 'pending_verifier' | 'confirmed' | 'declined' | 'expired'
  reason: string
  expiresAt: string
}

export function resolveExpiringStatus(
  status: string,
  pendingStatus: 'pending' | 'pending_verifier',
  expired: boolean,
): string {
  return status === 'expired_finalization' || (status === pendingStatus && expired)
    ? 'expired'
    : status
}
export type MediaProjection = {
  id: string
  uploaderUserId: string
  state: 'ready'
  contentType: 'image/jpeg'
  sizeBytes: number
  width: number
  height: number
  caption: string | null
  purpose: 'gallery' | 'fallback'
  createdAt: string
}
export type MediaIntentInput = {
  sourceSha256: string
  sizeBytes: number
  contentType: 'image/jpeg' | 'image/png' | 'image/webp'
  caption?: string | null | undefined
  purpose: 'gallery' | 'fallback'
  attemptId?: string | undefined
}

export type ProcessedMedia = {
  data: Buffer
  info: { width: number; height: number; size: number }
}

export type MediaProcessor = (
  bytes: Buffer,
  declaredContentType: MediaIntentInput['contentType'],
) => Promise<ProcessedMedia>

export const processMedia: MediaProcessor = async (bytes, declaredContentType) => {
  let image: Sharp
  let metadata: Metadata
  try {
    image = sharp(bytes, { failOn: 'error', limitInputPixels: 12_000_000 })
    metadata = await image.metadata()
  } catch {
    throw new RaidError('MEDIA_INVALID', 400, 'Неподдерживаемое изображение')
  }
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width > 8_000 ||
    metadata.height > 8_000 ||
    metadata.width * metadata.height > 12_000_000 ||
    !['jpeg', 'png', 'webp'].includes(metadata.format ?? '') ||
    (({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as Record<
      string,
      string
    >)[metadata.format ?? ''] !== declaredContentType)
  ) {
    throw new RaidError('MEDIA_INVALID', 400, 'Неподдерживаемое изображение')
  }
  const processed = await (async () => {
    try {
      return await image
        .rotate()
        .resize({ width: 2_048, height: 2_048, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer({ resolveWithObject: true })
    } catch {
      throw new RaidError('MEDIA_INVALID', 400, 'Неподдерживаемое изображение')
    }
  })()
  if (processed.data.length > 3 * 1024 * 1024) {
    throw new RaidError('MEDIA_OUTPUT_TOO_LARGE', 400, 'Фотография слишком большая')
  }
  return processed
}

type RaidRow = {
  id: string
  kabanda_id: string
  organizer_user_id: string
  navigator_user_id: string | null
  title: string
  description: string | null
  scheduled_at: Date | null
  started_at: Date | null
  finalizing_at: Date | null
  finalization_deadline_at: Date | null
  finalization_partial: boolean
  server_now: Date
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
    action: RaidCommandAction,
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
  nearbyCheckins(actorUserId: string, raidId: string, input: NearbyCheckinInput): Promise<unknown>
  createCheckin(actorUserId: string, raidId: string, input: CheckinInput, operationId: string): Promise<CheckinResponse>
  listPendingClaims(actorUserId: string, raidId: string): Promise<{ claims: ClaimProjection[] }>
  respondClaim(actorUserId: string, raidId: string, claimId: string, decision: 'confirm' | 'decline', operationId: string): Promise<{ claim: ClaimProjection; credit?: CreditProjection }>
  createFallback(actorUserId: string, raidId: string, input: { attemptId: string; mediaId: string; verifierUserId: string; presentParticipantIds: string[]; reason: string }, operationId: string): Promise<{ fallback: FallbackProjection; credits?: CreditProjection[] }>
  listPendingFallbacks(actorUserId: string, raidId: string): Promise<{ fallbacks: FallbackProjection[] }>
  respondFallback(actorUserId: string, raidId: string, fallbackId: string, decision: 'confirm' | 'decline', operationId: string): Promise<{ fallback: FallbackProjection; credits?: CreditProjection[] }>
  createMediaIntent(actorUserId: string, raidId: string, input: MediaIntentInput, operationId: string): Promise<{ intentId: string; uploadCapability: string; expiresAt: string; state: 'pending_upload' }>
  uploadMedia(actorUserId: string, raidId: string, intentId: string, capability: string, contentSha256: string, bytes: Buffer): Promise<{ media: MediaProjection }>
  listMedia(actorUserId: string, raidId: string, limit: number, cursor?: string): Promise<{ media: MediaProjection[]; nextCursor: string | null }>
  readMedia(actorUserId: string, raidId: string, mediaId: string): Promise<{ bytes: Buffer; contentType: 'image/jpeg' }>
  tombstoneMedia(actorUserId: string, raidId: string, mediaId: string, operationId: string): Promise<{ deleted: true }>
  finishRaid(actorUserId: string, raidId: string, input: FinishRaidInput, operationId: string): Promise<{ raid: RaidProjection; finalization: RaidFinalizationProjection }>
  settleFinalization(actorUserId: string, raidId: string, expectedVersion: number, operationId: string): Promise<{ raid: RaidProjection; result: RaidResult }>
  leaveRaid(actorUserId: string, raidId: string, expectedVersion: number, operationId: string): Promise<{ raid: RaidProjection }>
  getResult(actorUserId: string, raidId: string): Promise<RaidResult>
  listHistory(actorUserId: string, kabandaId: string, limit: number, cursor?: string): Promise<{ raids: Array<{ raidId: string; title: string; completedAt: string; partial: boolean; team: RaidMetrics; personal: RaidMetrics }>; nextCursor: string | null }>
  getProgress(actorUserId: string, kabandaId: string): Promise<{ progress: { team: RaidMetrics & { completedRaids: number }; personal: RaidMetrics & { completedRaids: number } } }>
  getShareCard(actorUserId: string, raidId: string): Promise<Buffer>
}

export class DatabaseRaidService implements RaidService {
  constructor(
    private readonly pool: Pool,
    private readonly mediaCapabilitySecret: string,
    private readonly mediaProcessor: MediaProcessor = processMedia,
  ) {}

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

      const membership = await client.query(
        `SELECT 1 FROM kabanda_memberships m
         JOIN kabandas k ON k.id = m.kabanda_id AND k.archived_at IS NULL
         WHERE m.kabanda_id = $1 AND m.user_id = $2 AND m.removed_at IS NULL
         FOR UPDATE OF m`,
        [kabandaId, actorUserId],
      )
      if (!membership.rowCount) throw this.notFound()

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
    action: RaidCommandAction,
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
        if (current.client_instance_id === input.clientInstanceId) {
          throw new RaidError(
            'NAVIGATOR_LEASE_ALREADY_CURRENT',
            409,
            'Это устройство уже владеет записью маршрута',
          )
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

  async nearbyCheckins(
    actorUserId: string,
    raidId: string,
    input: NearbyCheckinInput,
  ): Promise<{
    policy: { version: 'v1'; radiusMeters: 75; maxAgeSeconds: 60; maxAccuracyMeters: 50 }
    points: Array<{
      pointSnapshotId: string
      sourcePointId: string
      name: string
      latitude: number
      longitude: number
      distanceMeters: number
      creditedByMe: boolean
      creditedByTeam: boolean
    }>
  }> {
    const client = await this.pool.connect()
    try {
      const raid = await this.lockRaid(client, actorUserId, raidId)
      this.requireActiveParticipant(raid)
      const result = await client.query<{
        id: string
        source_point_id: string
        name: string
        latitude: number
        longitude: number
        distance_meters: number
        credited_by_me: boolean
        credited_by_team: boolean
      }>(
        `SELECT s.id, s.source_point_id, s.name,
           ST_Y(s.location::geometry) AS latitude,
           ST_X(s.location::geometry) AS longitude,
           ST_Distance(s.location, q.location) AS distance_meters,
           EXISTS (SELECT 1 FROM raid_point_credits c
             WHERE c.raid_id = s.raid_id AND c.point_snapshot_id = s.id
               AND c.user_id = $2) AS credited_by_me,
           EXISTS (SELECT 1 FROM raid_point_credits c
             WHERE c.raid_id = s.raid_id AND c.point_snapshot_id = s.id) AS credited_by_team
         FROM raid_point_snapshots s
         CROSS JOIN (SELECT ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography AS location) q
         WHERE s.raid_id = $1 AND ST_DWithin(s.location, q.location, 75)
         ORDER BY distance_meters, s.position, s.id LIMIT $5`,
        [raid.id, actorUserId, input.latitude, input.longitude, input.limit],
      )
      return {
        policy: { version: 'v1', radiusMeters: 75, maxAgeSeconds: 60, maxAccuracyMeters: 50 },
        points: result.rows.map((row) => ({
          pointSnapshotId: row.id,
          sourcePointId: row.source_point_id,
          name: row.name,
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
          distanceMeters: Math.round(Number(row.distance_meters) * 10) / 10,
          creditedByMe: row.credited_by_me,
          creditedByTeam: row.credited_by_team,
        })),
      }
    } finally {
      client.release()
    }
  }

  async createCheckin(
    actorUserId: string,
    raidId: string,
    input: CheckinInput,
    operationId: string,
  ): Promise<CheckinResponse> {
    const requestFingerprint = fingerprint('create-check-in', raidId, input)
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replayFeature<CheckinResponse>(
        client,
        actorUserId,
        operationId,
        requestFingerprint,
      )
      if (replay) return replay
      const raid = await this.lockRaid(client, actorUserId, raidId)
      this.requireActiveParticipant(raid)
      if (input.organizerAttestation && raid.organizer_user_id !== actorUserId) {
        throw this.forbiddenCommand()
      }
      const pointResult = await client.query<{
        id: string
        source_point_id: string
        name: string
        distance_meters: number
      }>(
        `SELECT s.id, s.source_point_id, s.name,
           ST_Distance(s.location,
             ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography) AS distance_meters
         FROM raid_point_snapshots s WHERE s.id = $1 AND s.raid_id = $4`,
        [input.pointSnapshotId, input.evidence.latitude, input.evidence.longitude, raid.id],
      )
      const point = pointResult.rows[0]
      if (!point) throw this.notFound()
      const presentIds = [...new Set(input.presentParticipantIds)].filter(
        (id) => id !== actorUserId,
      )
      await this.requireRaidParticipants(client, raid, presentIds)
      const capturedAt = new Date(input.evidence.capturedAt)
      const ageMs = Date.now() - capturedAt.getTime()
      const distanceMeters = Number(point.distance_meters)
      let reason: CheckinResponse['reason'] = null
      if (ageMs > 60_000 || ageMs < -30_000) reason = 'location_expired'
      else if (input.evidence.accuracyMeters > 50) reason = 'accuracy_insufficient'
      else if (distanceMeters > 75) reason = 'too_far'
      const accepted = reason === null
      const attemptResult = await client.query<{ id: string }>(
        `INSERT INTO raid_checkin_attempts
          (raid_id, point_snapshot_id, actor_user_id, evidence_location,
           evidence_captured_at, evidence_accuracy_meters, organizer_attestation,
           outcome, reason, distance_meters)
         VALUES ($1, $2, $3,
           ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
           $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          raid.id,
          point.id,
          actorUserId,
          input.evidence.longitude,
          input.evidence.latitude,
          capturedAt,
          input.evidence.accuracyMeters,
          input.organizerAttestation,
          accepted ? 'accepted' : 'needs_manual_verification',
          accepted ? null : reason,
          distanceMeters,
        ],
      )
      const attemptId = attemptResult.rows[0]!.id
      const credits: CreditProjection[] = []
      const claims: ClaimProjection[] = []
      if (accepted) {
        const source = input.organizerAttestation ? 'organizer_attestation' : 'gps'
        const creditedIds = input.organizerAttestation
          ? [actorUserId, ...presentIds]
          : [actorUserId]
        credits.push(
          ...(await this.insertCredits(client, raid.id, point.id, attemptId, creditedIds, source)),
        )
        if (!input.organizerAttestation && presentIds.length > 0) {
          claims.push(...(await this.insertClaims(client, raid.id, attemptId, presentIds)))
        }
      }
      const response: CheckinResponse = {
        operationId,
        attemptId,
        outcome: accepted ? 'accepted' : 'needs_manual_verification',
        reason: accepted ? null : reason,
        point: { pointSnapshotId: point.id, sourcePointId: point.source_point_id, name: point.name },
        ...(Number.isFinite(distanceMeters) ? { distanceMeters: Math.round(distanceMeters * 10) / 10 } : {}),
        credits,
        claims,
      }
      await this.storeFeatureReceipt(client, actorUserId, operationId, raid.id, 'create-check-in', requestFingerprint, response)
      return response
    })
  }

  async listPendingClaims(
    actorUserId: string,
    raidId: string,
  ): Promise<{ claims: ClaimProjection[] }> {
    const client = await this.pool.connect()
    try {
      const raid = await this.lockRaid(client, actorUserId, raidId)
      this.requireFinalizationCommitParticipant(raid)
      const rows = await client.query(
        `SELECT id, attempt_id, user_id, status, expires_at, false AS expired
         FROM raid_checkin_claims
         WHERE raid_id = $1 AND user_id = $2 AND status = 'pending'
           AND expires_at > clock_timestamp()
         ORDER BY created_at, id LIMIT 20`,
        [raid.id, actorUserId],
      )
      return { claims: rows.rows.map((row) => this.claimProjection(row)) }
    } finally {
      client.release()
    }
  }

  async respondClaim(
    actorUserId: string,
    raidId: string,
    claimId: string,
    decision: 'confirm' | 'decline',
    operationId: string,
  ): Promise<{ claim: ClaimProjection; credit?: CreditProjection }> {
    const requestFingerprint = fingerprint(`claim-${decision}`, `${raidId}:${claimId}`, {})
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replayFeature<{ claim: ClaimProjection; credit?: CreditProjection }>(client, actorUserId, operationId, requestFingerprint)
      if (replay) return replay
      const raid = await this.lockRaid(client, actorUserId, raidId)
      this.requireFinalizationCommitParticipant(raid)
      const result = await client.query<{
        id: string
        attempt_id: string
        user_id: string
        status: string
        expires_at: Date
        available: boolean
        point_snapshot_id: string
      }>(
        `SELECT c.id, c.attempt_id, c.user_id, c.status, c.expires_at,
           c.expires_at > clock_timestamp() AS available, a.point_snapshot_id
         FROM raid_checkin_claims c JOIN raid_checkin_attempts a ON a.id = c.attempt_id
         WHERE c.id = $1 AND c.raid_id = $2 FOR UPDATE OF c`,
        [claimId, raid.id],
      )
      const row = result.rows[0]
      if (!row || row.user_id !== actorUserId) throw this.notFound()
      if (row.status !== 'pending' || !row.available) {
        throw new RaidError('CLAIM_UNAVAILABLE', 409, 'Подтверждение уже недоступно')
      }
      await client.query(
        `UPDATE raid_checkin_claims SET status = $2, responded_at = now() WHERE id = $1`,
        [row.id, decision === 'confirm' ? 'confirmed' : 'declined'],
      )
      const claim = this.claimProjection({
        ...row,
        expired: !row.available,
        status: decision === 'confirm' ? 'confirmed' : 'declined',
      })
      const response: { claim: ClaimProjection; credit?: CreditProjection } = { claim }
      if (decision === 'confirm') {
        const credit = (await this.insertCredits(client, raid.id, row.point_snapshot_id, row.attempt_id, [actorUserId], 'claim'))[0]
        if (credit) response.credit = credit
      }
      await this.storeFeatureReceipt(client, actorUserId, operationId, raid.id, `claim-${decision}`, requestFingerprint, response)
      return response
    })
  }

  async createFallback(
    actorUserId: string,
    raidId: string,
    input: {
      attemptId: string
      mediaId: string
      verifierUserId: string
      presentParticipantIds: string[]
      reason: string
    },
    operationId: string,
  ): Promise<{ fallback: FallbackProjection }> {
    const requestFingerprint = fingerprint('create-check-in-fallback', raidId, input)
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replayFeature<{ fallback: FallbackProjection }>(client, actorUserId, operationId, requestFingerprint)
      if (replay) return replay
      const raid = await this.lockRaid(client, actorUserId, raidId)
      this.requireActiveParticipant(raid)
      if (input.verifierUserId === actorUserId) {
        throw new RaidError('FALLBACK_VERIFIER_INVALID', 400, 'Нужен другой участник')
      }
      const presentIds = [...new Set(input.presentParticipantIds)].filter(
        (id) => id !== actorUserId && id !== input.verifierUserId,
      )
      await this.requireRaidParticipants(client, raid, [input.verifierUserId, ...presentIds])
      const evidence = await client.query(
        `SELECT 1 FROM raid_checkin_attempts a
         JOIN raid_media m ON m.id = $2 AND m.raid_id = a.raid_id
           AND m.uploader_user_id = $3 AND m.state = 'ready'
           AND m.purpose = 'fallback' AND m.attempt_id = a.id
         WHERE a.id = $1 AND a.raid_id = $4 AND a.actor_user_id = $3
           AND a.outcome = 'needs_manual_verification'
         FOR UPDATE OF m`,
        [input.attemptId, input.mediaId, actorUserId, raid.id],
      )
      if (!evidence.rowCount) throw this.notFound()
      let inserted: QueryResult<{
        id: string
        attempt_id: string
        media_id: string
        verifier_user_id: string
        status: string
        reason: string
        expires_at: Date
        expired: boolean
      }>
      try {
        inserted = await client.query(
          `INSERT INTO raid_checkin_fallbacks
            (raid_id, attempt_id, media_id, requester_user_id, verifier_user_id,
             present_participant_ids, reason)
           VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7)
           RETURNING id, attempt_id, media_id, verifier_user_id, status, reason, expires_at,
             expires_at <= clock_timestamp() AS expired`,
          [
            raid.id,
            input.attemptId,
            input.mediaId,
            actorUserId,
            input.verifierUserId,
            presentIds,
            input.reason,
          ],
        )
      } catch (error) {
        if (
          (error as { constraint?: string }).constraint ===
          'raid_checkin_fallbacks_one_open_request_idx'
        ) {
          throw new RaidError(
            'FALLBACK_ALREADY_REQUESTED',
            409,
            'Проверка этой отметки уже запрошена',
          )
        }
        throw error
      }
      const response = { fallback: this.fallbackProjection(inserted.rows[0]!) }
      await this.storeFeatureReceipt(client, actorUserId, operationId, raid.id, 'create-check-in-fallback', requestFingerprint, response)
      return response
    })
  }

  async listPendingFallbacks(
    actorUserId: string,
    raidId: string,
  ): Promise<{ fallbacks: FallbackProjection[] }> {
    const client = await this.pool.connect()
    try {
      const raid = await this.lockRaid(client, actorUserId, raidId)
      this.requireFinalizationCommitParticipant(raid)
      const rows = await client.query(
        `SELECT id, attempt_id, media_id, verifier_user_id, status, reason, expires_at,
           false AS expired
         FROM raid_checkin_fallbacks
         WHERE raid_id = $1 AND verifier_user_id = $2 AND status = 'pending_verifier'
           AND expires_at > clock_timestamp()
         ORDER BY created_at, id LIMIT 20`,
        [raid.id, actorUserId],
      )
      return { fallbacks: rows.rows.map((row) => this.fallbackProjection(row)) }
    } finally {
      client.release()
    }
  }

  async respondFallback(
    actorUserId: string,
    raidId: string,
    fallbackId: string,
    decision: 'confirm' | 'decline',
    operationId: string,
  ): Promise<{ fallback: FallbackProjection; credits?: CreditProjection[] }> {
    const requestFingerprint = fingerprint(`fallback-${decision}`, `${raidId}:${fallbackId}`, {})
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replayFeature<{ fallback: FallbackProjection; credits?: CreditProjection[] }>(client, actorUserId, operationId, requestFingerprint)
      if (replay) return replay
      const raid = await this.lockRaid(client, actorUserId, raidId)
      this.requireFinalizationCommitParticipant(raid)
      const result = await client.query<{
        id: string
        attempt_id: string
        media_id: string
        requester_user_id: string
        verifier_user_id: string
        present_participant_ids: string[]
        status: string
        reason: string
        expires_at: Date
        available: boolean
        point_snapshot_id: string
      }>(
        `SELECT f.id, f.attempt_id, f.media_id, f.requester_user_id,
           f.verifier_user_id, f.present_participant_ids, f.status, f.reason,
           f.expires_at, f.expires_at > clock_timestamp() AS available,
           a.point_snapshot_id
         FROM raid_checkin_fallbacks f JOIN raid_checkin_attempts a ON a.id = f.attempt_id
         WHERE f.id = $1 AND f.raid_id = $2 FOR UPDATE OF f`,
        [fallbackId, raid.id],
      )
      const row = result.rows[0]
      if (!row || row.verifier_user_id !== actorUserId) throw this.notFound()
      if (row.status !== 'pending_verifier' || !row.available) {
        throw new RaidError('FALLBACK_UNAVAILABLE', 409, 'Проверка уже недоступна')
      }
      if (decision === 'confirm') {
        const evidence = await client.query(
          `SELECT 1 FROM raid_media
           WHERE id = $1 AND raid_id = $2 AND attempt_id = $3
             AND uploader_user_id = $4 AND purpose = 'fallback' AND state = 'ready'
           FOR UPDATE`,
          [row.media_id, raid.id, row.attempt_id, row.requester_user_id],
        )
        if (!evidence.rowCount) {
          throw new RaidError(
            'FALLBACK_MEDIA_UNAVAILABLE',
            409,
            'Фото для подтверждения больше недоступно',
          )
        }
      }
      await client.query(
        `UPDATE raid_checkin_fallbacks SET status = $2, responded_at = now() WHERE id = $1`,
        [row.id, decision === 'confirm' ? 'confirmed' : 'declined'],
      )
      const response: { fallback: FallbackProjection; credits?: CreditProjection[] } = {
        fallback: this.fallbackProjection({
          ...row,
          expired: !row.available,
          status: decision === 'confirm' ? 'confirmed' : 'declined',
        }),
      }
      if (decision === 'confirm') {
        const creditedIds = [row.requester_user_id, ...row.present_participant_ids]
        await this.requireRaidParticipants(client, raid, creditedIds)
        response.credits = await this.insertCredits(client, raid.id, row.point_snapshot_id, row.attempt_id, creditedIds, 'media_fallback')
      }
      await this.storeFeatureReceipt(client, actorUserId, operationId, raid.id, `fallback-${decision}`, requestFingerprint, response)
      return response
    })
  }

  async createMediaIntent(
    actorUserId: string,
    raidId: string,
    input: MediaIntentInput,
    operationId: string,
  ): Promise<{ intentId: string; uploadCapability: string; expiresAt: string; state: 'pending_upload' }> {
    const requestFingerprint = fingerprint('create-media-intent', raidId, input)
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replayFeature<{
        intentId: string
        expiresAt: string
        state: 'pending_upload'
      }>(client, actorUserId, operationId, requestFingerprint)
      if (replay) {
        return {
          ...replay,
          uploadCapability: deriveMediaUploadCapability(
            this.mediaCapabilitySecret,
            raidId,
            replay.intentId,
            actorUserId,
          ),
        }
      }
      const raid = await this.lockRaid(client, actorUserId, raidId)
      this.requireActiveParticipant(raid)
      if (input.purpose === 'fallback' && !input.attemptId) {
        throw new RaidError('MEDIA_ATTEMPT_REQUIRED', 400, 'Для подтверждения нужна попытка')
      }
      if (input.attemptId) {
        const attempt = await client.query(
          `SELECT 1 FROM raid_checkin_attempts
           WHERE id = $1 AND raid_id = $2 AND actor_user_id = $3`,
          [input.attemptId, raid.id, actorUserId],
        )
        if (!attempt.rowCount) throw this.notFound()
      }
      const count = await client.query<{ count: string }>(
        `SELECT count(*) FROM raid_media
         WHERE raid_id = $1 AND (
           state = 'ready'
           OR (state = 'pending_upload' AND upload_expires_at > clock_timestamp())
           OR (state = 'processing'
             AND processing_started_at > clock_timestamp() - interval '2 minutes')
         )`,
        [raid.id],
      )
      if (Number(count.rows[0]!.count) >= 100) {
        throw new RaidError('MEDIA_LIMIT_REACHED', 409, 'В рейде уже 100 фотографий')
      }
      const accepted = await client.query(
        `SELECT 1 FROM raid_media
         WHERE raid_id = $1 AND uploader_user_id = $2 AND source_sha256 = $3
           AND state IN ('ready', 'tombstoned') LIMIT 1`,
        [raid.id, actorUserId, input.sourceSha256],
      )
      if (accepted.rowCount) {
        throw new RaidError('MEDIA_ALREADY_ACCEPTED', 409, 'Фотография уже загружена')
      }
      const intentId = randomUUID()
      const capability = deriveMediaUploadCapability(
        this.mediaCapabilitySecret,
        raid.id,
        intentId,
        actorUserId,
      )
      const result = await client.query<{ id: string; upload_expires_at: Date }>(
        `INSERT INTO raid_media
          (id, raid_id, uploader_user_id, attempt_id, purpose, caption, source_sha256,
           declared_size_bytes, declared_content_type, upload_capability_hash,
           upload_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           now() + interval '15 minutes') RETURNING id, upload_expires_at`,
        [intentId, raid.id, actorUserId, input.attemptId ?? null, input.purpose, input.caption ?? null, input.sourceSha256, input.sizeBytes, input.contentType, this.secretHash(capability)],
      )
      const media = result.rows[0]!
      const response = {
        intentId: media.id,
        uploadCapability: capability,
        expiresAt: media.upload_expires_at.toISOString(),
        state: 'pending_upload' as const,
      }
      await this.storeFeatureReceipt(
        client,
        actorUserId,
        operationId,
        raid.id,
        'create-media-intent',
        requestFingerprint,
        {
          intentId: response.intentId,
          expiresAt: response.expiresAt,
          state: response.state,
        },
      )
      return response
    })
  }

  async uploadMedia(
    actorUserId: string,
    raidId: string,
    intentId: string,
    capability: string,
    contentSha256: string,
    bytes: Buffer,
  ): Promise<{ media: MediaProjection }> {
    const sourceHash = createHash('sha256').update(bytes).digest('hex')
    if (sourceHash !== contentSha256) {
      throw new RaidError('MEDIA_HASH_MISMATCH', 400, 'Хэш файла не совпадает')
    }
    const claim = await transaction(this.pool, async (client) => {
      const raid = await this.lockRaid(client, actorUserId, raidId)
      this.requireFinalizationCommitParticipant(raid)
      const result = await client.query<{
        id: string
        uploader_user_id: string
        source_sha256: string
        declared_size_bytes: number
        declared_content_type: string
        upload_capability_hash: string
        upload_expires_at: Date
        upload_available: boolean
        state: string
        processing_started_at: Date | null
        processing_fresh: boolean
      }>(
        `SELECT id, uploader_user_id, source_sha256, declared_size_bytes, declared_content_type,
           upload_capability_hash, upload_expires_at,
           upload_expires_at > clock_timestamp() AS upload_available,
           state, processing_started_at,
           processing_started_at > clock_timestamp() - interval '2 minutes' AS processing_fresh
         FROM raid_media WHERE id = $1 AND raid_id = $2 FOR UPDATE`,
        [intentId, raid.id],
      )
      const media = result.rows[0]
      if (!media || media.uploader_user_id !== actorUserId) throw this.notFound()
      if (media.upload_capability_hash !== this.secretHash(capability)) throw this.notFound()
      if (media.source_sha256 !== sourceHash || media.declared_size_bytes !== bytes.length) {
        throw new RaidError('MEDIA_HASH_MISMATCH', 400, 'Файл не совпадает с intent')
      }
      if (media.state === 'ready') return { ready: true as const }
      if (media.state === 'tombstoned') throw this.notFound()
      if (media.state === 'pending_upload' && !media.upload_available) {
        throw new RaidError('MEDIA_INTENT_EXPIRED', 409, 'Загрузка просрочена')
      }
      if (
        media.state === 'processing' &&
        media.processing_fresh
      ) {
        throw new RaidError('MEDIA_PROCESSING', 409, 'Фотография уже обрабатывается')
      }
      const processingToken = randomUUID()
      const claimed = await client.query(
        `UPDATE raid_media SET state = 'processing', processing_started_at = clock_timestamp(),
           processing_token = $2
         WHERE id = $1 AND (
           state = 'pending_upload' OR
           (state = 'processing' AND processing_started_at <= clock_timestamp() - interval '2 minutes')
         )
         RETURNING id`,
        [media.id, processingToken],
      )
      if (!claimed.rowCount) {
        throw new RaidError(
          'MEDIA_PROCESSING_SUPERSEDED',
          409,
          'Обработку фотографии уже продолжил другой запрос',
        )
      }
      return {
        ready: false as const,
        declaredContentType: media.declared_content_type as MediaIntentInput['contentType'],
        processingToken,
      }
    })
    if (claim.ready) return { media: await this.mediaProjectionById(actorUserId, raidId, intentId) }

    let processed: ProcessedMedia
    try {
      processed = await this.mediaProcessor(bytes, claim.declaredContentType)
    } catch (error) {
      try {
        await transaction(this.pool, async (client) => {
          const raid = await this.lockRaid(client, actorUserId, raidId)
          const ownership = await client.query<{ owns_processing: boolean }>(
            `SELECT state = 'processing' AND processing_token = $3::uuid AS owns_processing
             FROM raid_media WHERE id = $1 AND raid_id = $2 FOR UPDATE`,
            [intentId, raidId, claim.processingToken],
          )
          if (!ownership.rows[0]?.owns_processing) {
            throw new RaidError(
              'MEDIA_PROCESSING_SUPERSEDED',
              409,
              'Обработку фотографии уже продолжил другой запрос',
            )
          }
          const commitWindowOpen =
            raid.participant_state === 'active' &&
            (raid.state === 'active' ||
              (raid.state === 'finalizing' &&
                Boolean(
                  raid.finalization_deadline_at &&
                    raid.finalization_deadline_at.getTime() > raid.server_now.getTime(),
                )))
          if (commitWindowOpen) {
            await client.query(
              `UPDATE raid_media SET state = 'pending_upload', processing_started_at = NULL,
                 processing_token = NULL
               WHERE id = $1 AND raid_id = $2 AND state = 'processing'
                 AND processing_token = $3::uuid`,
              [intentId, raidId, claim.processingToken],
            )
          }
        })
      } catch (resetError) {
        if (
          resetError instanceof RaidError &&
          resetError.code === 'MEDIA_PROCESSING_SUPERSEDED'
        ) {
          throw resetError
        }
        if (!(resetError instanceof RaidError)) throw resetError
      }
      if (error instanceof RaidError) throw error
      throw new RaidError('MEDIA_INVALID', 400, 'Не удалось прочитать изображение')
    }
    await transaction(this.pool, async (client) => {
      const raid = await this.lockRaid(client, actorUserId, raidId)
      this.requireFinalizationCommitParticipant(raid)
      const committed = await client.query(
        `UPDATE raid_media SET state = 'ready', content_bytes = $2,
           content_type = 'image/jpeg', size_bytes = $3, width = $4, height = $5,
           content_sha256 = $6, ready_at = clock_timestamp(), processing_started_at = NULL,
           processing_token = NULL
         WHERE id = $1 AND raid_id = $7 AND state = 'processing'
           AND processing_token = $8::uuid
         RETURNING id`,
        [
          intentId,
          processed.data,
          processed.data.length,
          processed.info.width,
          processed.info.height,
          createHash('sha256').update(processed.data).digest('hex'),
          raidId,
          claim.processingToken,
        ],
      )
      if (!committed.rowCount) {
        throw new RaidError(
          'MEDIA_PROCESSING_SUPERSEDED',
          409,
          'Обработку фотографии уже продолжил другой запрос',
        )
      }
    })
    return { media: await this.mediaProjectionById(actorUserId, raidId, intentId) }
  }

  async listMedia(
    actorUserId: string,
    raidId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ media: MediaProjection[]; nextCursor: string | null }> {
    const client = await this.pool.connect()
    try {
      await this.visibleRaid(client, actorUserId, raidId)
      let cursorValue: { createdAt: string; id: string } | null = null
      try {
        cursorValue = cursor
          ? (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
              createdAt: string
              id: string
            })
          : null
        if (
          cursorValue &&
          (Number.isNaN(new Date(cursorValue.createdAt).getTime()) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              cursorValue.id,
            ))
        ) {
          throw new Error('invalid')
        }
      } catch {
        throw new RaidError('MEDIA_CURSOR_INVALID', 400, 'Некорректный cursor')
      }
      const result = await client.query(
        `SELECT id, uploader_user_id, state, content_type, size_bytes, width, height,
           caption, purpose, created_at
         FROM raid_media
         WHERE raid_id = $1 AND state = 'ready'
           AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [raidId, cursorValue?.createdAt ?? null, cursorValue?.id ?? null, limit + 1],
      )
      const hasMore = result.rows.length > limit
      const rows = result.rows.slice(0, limit)
      return {
        media: rows.map((row) => this.mediaProjection(row)),
        nextCursor: hasMore
          ? Buffer.from(
              JSON.stringify({
                createdAt: rows[rows.length - 1]!.created_at.toISOString(),
                id: rows[rows.length - 1]!.id,
              }),
            ).toString('base64url')
          : null,
      }
    } finally {
      client.release()
    }
  }

  async readMedia(
    actorUserId: string,
    raidId: string,
    mediaId: string,
  ): Promise<{ bytes: Buffer; contentType: 'image/jpeg' }> {
    const client = await this.pool.connect()
    try {
      await this.visibleRaid(client, actorUserId, raidId)
      const result = await client.query<{ content_bytes: Buffer }>(
        `SELECT content_bytes FROM raid_media
         WHERE id = $1 AND raid_id = $2 AND state = 'ready'`,
        [mediaId, raidId],
      )
      if (!result.rows[0]?.content_bytes) throw this.notFound()
      return { bytes: result.rows[0].content_bytes, contentType: 'image/jpeg' }
    } finally {
      client.release()
    }
  }

  async tombstoneMedia(
    actorUserId: string,
    raidId: string,
    mediaId: string,
    operationId: string,
  ): Promise<{ deleted: true }> {
    const requestFingerprint = fingerprint('tombstone-media', `${raidId}:${mediaId}`, {})
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replayFeature<{ deleted: true }>(client, actorUserId, operationId, requestFingerprint)
      if (replay) return replay
      const raid = await this.lockRaid(client, actorUserId, raidId)
      const media = await client.query<{ uploader_user_id: string; state: string }>(
        'SELECT uploader_user_id, state FROM raid_media WHERE id = $1 AND raid_id = $2 FOR UPDATE',
        [mediaId, raid.id],
      )
      const row = media.rows[0]
      if (!row) throw this.notFound()
      if (
        row.uploader_user_id !== actorUserId &&
        raid.organizer_user_id !== actorUserId &&
        raid.membership_role !== 'owner'
      ) {
        throw this.notFound()
      }
      if (
        raid.state === 'finalizing' &&
        (!raid.finalization_deadline_at ||
          raid.finalization_deadline_at.getTime() <= raid.server_now.getTime())
      ) {
        throw new RaidError('FINALIZATION_CLOSED', 409, 'Окно завершения уже закрыто')
      }
      const fallbackEvidence = await client.query(
        `SELECT 1 FROM raid_checkin_fallbacks
         WHERE media_id = $1 AND status <> 'declined' LIMIT 1`,
        [mediaId],
      )
      if (fallbackEvidence.rowCount) {
        throw new RaidError(
          'MEDIA_IS_FALLBACK_EVIDENCE',
          409,
          'Фото используется как подтверждение отметки',
        )
      }
      await client.query(
        `UPDATE raid_media SET state = 'tombstoned', content_bytes = NULL,
           tombstoned_at = now() WHERE id = $1`,
        [mediaId],
      )
      const response = { deleted: true as const }
      await this.storeFeatureReceipt(client, actorUserId, operationId, raid.id, 'tombstone-media', requestFingerprint, response)
      return response
    })
  }

  async finishRaid(
    actorUserId: string,
    raidId: string,
    input: FinishRaidInput,
    operationId: string,
  ): Promise<FinishRaidResponse> {
    const requestFingerprint = fingerprint('finish', raidId, input)
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replay<FinishRaidResponse>(
        client,
        actorUserId,
        operationId,
        requestFingerprint,
      )
      if (replay) return replay
      const raid = await this.lockRaid(client, actorUserId, raidId)
      this.requireOrganizer(raid, actorUserId)
      this.requireVersion(raid, input.expectedVersion)
      if (raid.state !== 'active' && raid.state !== 'paused') {
        throw this.invalidTransition(raid)
      }
      const inventoryTotal =
        input.inventory.routePending +
        input.inventory.checkInsPending +
        input.inventory.mediaPending +
        input.inventory.needsAction
      const partial = inventoryTotal > 0
      if (partial && !input.confirmPartial) {
        throw new RaidError(
          'FINALIZATION_PARTIAL_CONFIRMATION_REQUIRED',
          409,
          'Подтверди завершение с несинхронизированными данными',
        )
      }
      const nextVersion = raid.version + 1
      await this.closeActivityWindow(client, raid.id, nextVersion)
      await this.closeCurrentLease(client, raid.id, 'finish')
      const finalized = await client.query<{ finalizing_at: Date; finalization_deadline_at: Date }>(
        `UPDATE raids SET state = 'finalizing', version = $2,
           finalizing_at = clock_timestamp(),
           finalization_deadline_at = clock_timestamp() + interval '2 minutes',
           finalization_partial = $3, finalization_inventory = $4,
           updated_at = clock_timestamp()
         WHERE id = $1 RETURNING finalizing_at, finalization_deadline_at`,
        [raid.id, nextVersion, partial, input.inventory],
      )
      const timing = finalized.rows[0]!
      await client.query(
        `INSERT INTO raid_route_finalization_cutoffs
          (raid_id, lease_id, generation, max_sequence, cutoff_at)
         SELECT raid_id, id, generation, max_accepted_sequence, $2
         FROM raid_navigator_leases WHERE raid_id = $1`,
        [raid.id, timing.finalizing_at],
      )
      const response: FinishRaidResponse = {
        raid: await this.project(client, actorUserId, raid.id),
        finalization: await this.finalizationProjection(client, raid.id),
      }
      await this.storeReceipt(client, {
        actorUserId,
        operationId,
        raidId: raid.id,
        command: 'finish',
        requestFingerprint,
        expectedVersion: input.expectedVersion,
        fromState: raid.state,
        mutatesState: true,
        response,
      })
      return response
    })
  }

  async settleFinalization(
    actorUserId: string,
    raidId: string,
    expectedVersion: number,
    operationId: string,
  ): Promise<SettleRaidResponse> {
    const input = { expectedVersion }
    const requestFingerprint = fingerprint('settle-finalization', raidId, input)
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replay<SettleRaidResponse>(
        client,
        actorUserId,
        operationId,
        requestFingerprint,
      )
      if (replay) return replay
      const raid = await this.lockRaid(client, actorUserId, raidId)
      this.requireOrganizer(raid, actorUserId)
      this.requireVersion(raid, expectedVersion)
      if (raid.state !== 'finalizing' || !raid.finalization_deadline_at || !raid.finalizing_at) {
        throw this.invalidTransition(raid)
      }
      const pending = await this.pendingCounts(client, raid.id)
      const beforeDeadline = raid.finalization_deadline_at.getTime() > raid.server_now.getTime()
      if (beforeDeadline && pending.claims + pending.fallbacks + pending.media > 0) {
        throw new RaidError('FINALIZATION_PENDING', 409, 'Ещё принимаются подтверждения', {
          pendingCounts: pending,
          deadlineAt: raid.finalization_deadline_at.toISOString(),
        })
      }
      const terminalizedTail = await this.expireFinalizationTail(client, raid.id)
      if (terminalizedTail > 0 && !raid.finalization_partial) {
        await client.query('UPDATE raids SET finalization_partial = true WHERE id = $1', [raid.id])
        raid.finalization_partial = true
      }
      const completedAt = (
        await client.query<{ completed_at: Date }>('SELECT clock_timestamp() AS completed_at')
      ).rows[0]!.completed_at
      const result = await this.buildImmutableResult(client, raid, completedAt, actorUserId)
      const sharePng = await renderRaidShareCard(result)
      await this.storeImmutableResult(client, result, sharePng)
      await client.query(
        `UPDATE raids SET state = 'completed', version = $2, completed_at = $3,
           updated_at = $3 WHERE id = $1`,
        [raid.id, raid.version + 1, completedAt],
      )
      const response: SettleRaidResponse = {
        raid: await this.project(client, actorUserId, raid.id),
        result,
      }
      await this.storeReceipt(client, {
        actorUserId,
        operationId,
        raidId: raid.id,
        command: 'settle-finalization',
        requestFingerprint,
        expectedVersion,
        fromState: raid.state,
        mutatesState: true,
        response,
      })
      return response
    })
  }

  async leaveRaid(
    actorUserId: string,
    raidId: string,
    expectedVersion: number,
    operationId: string,
  ): Promise<{ raid: RaidProjection }> {
    const input = { expectedVersion }
    const requestFingerprint = fingerprint('leave', raidId, input)
    return transaction(this.pool, async (client) => {
      await this.lockOperation(client, actorUserId, operationId)
      const replay = await this.replay<{ raid: RaidProjection }>(
        client,
        actorUserId,
        operationId,
        requestFingerprint,
      )
      if (replay) return replay
      const raid = await this.lockRaid(client, actorUserId, raidId)
      this.requireVersion(raid, expectedVersion)
      if (
        raid.organizer_user_id === actorUserId ||
        raid.participant_state !== 'active' ||
        (raid.state !== 'active' && raid.state !== 'paused')
      ) {
        throw this.forbiddenCommand()
      }
      if (raid.navigator_user_id === actorUserId) {
        throw new RaidError('NAVIGATOR_MUST_HANDOFF', 409, 'Сначала передай роль навигатора')
      }
      await client.query(
        `UPDATE raid_participants SET state = 'left', left_at = now(), updated_at = now()
         WHERE raid_id = $1 AND user_id = $2`,
        [raid.id, actorUserId],
      )
      await client.query('UPDATE raids SET version = $2, updated_at = now() WHERE id = $1', [
        raid.id,
        raid.version + 1,
      ])
      const response = { raid: await this.project(client, actorUserId, raid.id) }
      await this.storeReceipt(client, {
        actorUserId,
        operationId,
        raidId: raid.id,
        command: 'leave',
        requestFingerprint,
        expectedVersion,
        fromState: raid.state,
        mutatesState: true,
        response,
      })
      return response
    })
  }

  async getResult(actorUserId: string, raidId: string): Promise<RaidResult> {
    const result = await this.pool.query<{
      result_json: RaidResult
      duration_seconds: number | null
      distance_meters: number | null
      unique_points: number | null
      photos: number | null
    }>(
      `SELECT rr.result_json, rp.duration_seconds, rp.distance_meters,
         rp.unique_points, rp.photos
       FROM raid_results rr
       JOIN kabanda_memberships m
         ON m.kabanda_id = rr.kabanda_id AND m.user_id = $2 AND m.removed_at IS NULL
       LEFT JOIN raid_result_participants rp
         ON rp.raid_id = rr.raid_id AND rp.user_id = $2
       WHERE rr.raid_id = $1`,
      [raidId, actorUserId],
    )
    const row = result.rows[0]
    if (!row) throw this.notFound()
    return {
      ...row.result_json,
      personal: this.metrics(row),
    }
  }

  async listHistory(
    actorUserId: string,
    kabandaId: string,
    limit: number,
    cursor?: string,
  ): Promise<{
    raids: Array<{
      raidId: string
      title: string
      completedAt: string
      partial: boolean
      team: RaidMetrics
      personal: RaidMetrics
    }>
    nextCursor: string | null
  }> {
    await this.requireKabandaMembership(actorUserId, kabandaId)
    const parsedCursor = this.historyCursor(cursor)
    const result = await this.pool.query<{
      raid_id: string
      title: string
      completed_at: Date
      partial: boolean
      team_duration_seconds: number
      team_distance_meters: number
      team_unique_points: number
      team_photos: number
      duration_seconds: number | null
      distance_meters: number | null
      unique_points: number | null
      photos: number | null
    }>(
      `SELECT rr.raid_id, r.title, rr.completed_at, rr.partial,
         rr.team_duration_seconds, rr.team_distance_meters,
         rr.team_unique_points, rr.team_photos,
         rp.duration_seconds, rp.distance_meters, rp.unique_points, rp.photos
       FROM raid_results rr JOIN raids r ON r.id = rr.raid_id
       LEFT JOIN raid_result_participants rp
         ON rp.raid_id = rr.raid_id AND rp.user_id = $2
       WHERE rr.kabanda_id = $1
         AND ($3::timestamptz IS NULL OR (rr.completed_at, rr.raid_id) < ($3, $4::uuid))
       ORDER BY rr.completed_at DESC, rr.raid_id DESC LIMIT $5`,
      [kabandaId, actorUserId, parsedCursor?.completedAt ?? null, parsedCursor?.raidId ?? null, limit + 1],
    )
    const rows = result.rows.slice(0, limit)
    return {
      raids: rows.map((row) => ({
        raidId: row.raid_id,
        title: row.title,
        completedAt: row.completed_at.toISOString(),
        partial: row.partial,
        team: {
          durationSeconds: Number(row.team_duration_seconds),
          distanceMeters: this.roundDistance(row.team_distance_meters),
          uniquePoints: Number(row.team_unique_points),
          photos: Number(row.team_photos),
        },
        personal: this.metrics(row),
      })),
      nextCursor:
        result.rows.length > limit && rows.length
          ? Buffer.from(
              JSON.stringify({
                completedAt: rows[rows.length - 1]!.completed_at.toISOString(),
                raidId: rows[rows.length - 1]!.raid_id,
              }),
            ).toString('base64url')
          : null,
    }
  }

  async getProgress(
    actorUserId: string,
    kabandaId: string,
  ): Promise<{
    progress: {
      team: RaidMetrics & { completedRaids: number }
      personal: RaidMetrics & { completedRaids: number }
    }
  }> {
    await this.requireKabandaMembership(actorUserId, kabandaId)
    const result = await this.pool.query<{
      completed_raids: string
      team_duration_seconds: string
      team_distance_meters: number
      team_photos: string
      team_unique_points: string
      personal_completed_raids: string
      personal_duration_seconds: string
      personal_distance_meters: number
      personal_photos: string
      personal_unique_points: string
    }>(
      `SELECT
         count(DISTINCT rr.raid_id)::text AS completed_raids,
         coalesce(sum(rr.team_duration_seconds), 0)::text AS team_duration_seconds,
         coalesce(sum(rr.team_distance_meters), 0) AS team_distance_meters,
         coalesce(sum(rr.team_photos), 0)::text AS team_photos,
         (SELECT count(DISTINCT rtp.source_point_id)::text FROM raid_result_points rtp
          JOIN raid_results tr ON tr.raid_id = rtp.raid_id WHERE tr.kabanda_id = $1)
           AS team_unique_points,
         count(rp.raid_id)::text AS personal_completed_raids,
         coalesce(sum(rp.duration_seconds), 0)::text AS personal_duration_seconds,
         coalesce(sum(rp.distance_meters), 0) AS personal_distance_meters,
         coalesce(sum(rp.photos), 0)::text AS personal_photos,
         (SELECT count(DISTINCT rpp.source_point_id)::text FROM raid_result_points rpp
          JOIN raid_results pr ON pr.raid_id = rpp.raid_id
          WHERE pr.kabanda_id = $1 AND rpp.user_id = $2) AS personal_unique_points
       FROM raid_results rr
       LEFT JOIN raid_result_participants rp
         ON rp.raid_id = rr.raid_id AND rp.user_id = $2
       WHERE rr.kabanda_id = $1`,
      [kabandaId, actorUserId],
    )
    const row = result.rows[0]!
    return {
      progress: {
        team: {
          completedRaids: Number(row.completed_raids),
          durationSeconds: Number(row.team_duration_seconds),
          distanceMeters: this.roundDistance(row.team_distance_meters),
          uniquePoints: Number(row.team_unique_points),
          photos: Number(row.team_photos),
        },
        personal: {
          completedRaids: Number(row.personal_completed_raids),
          durationSeconds: Number(row.personal_duration_seconds),
          distanceMeters: this.roundDistance(row.personal_distance_meters),
          uniquePoints: Number(row.personal_unique_points),
          photos: Number(row.personal_photos),
        },
      },
    }
  }

  async getShareCard(actorUserId: string, raidId: string): Promise<Buffer> {
    const result = await this.pool.query<{ share_png: Buffer }>(
      `SELECT rr.share_png FROM raid_results rr
       JOIN kabanda_memberships m
         ON m.kabanda_id = rr.kabanda_id AND m.user_id = $2 AND m.removed_at IS NULL
       WHERE rr.raid_id = $1`,
      [raidId, actorUserId],
    )
    if (!result.rows[0]) throw this.notFound()
    return result.rows[0].share_png
  }

  async getRaid(actorUserId: string, raidId: string): Promise<RaidProjection> {
    const client = await this.pool.connect()
    try {
      await this.visibleRaidProjection(client, actorUserId, raidId)
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
         AND (r.organizer_user_id = $1 OR p.state = 'active')
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
    action: RaidCommandAction,
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
        const snapshots = await client.query(
          `INSERT INTO raid_point_snapshots
            (raid_id, source_point_id, collection_id, name, location, position)
           SELECT DISTINCT ON (p.id) $1, p.id, pc.id, p.name,
             p.location::geography, cp.position
           FROM point_collections pc
           JOIN collection_points cp
             ON cp.collection_id = pc.id AND cp.archived_at IS NULL
           JOIN points p
             ON p.id = cp.point_id AND p.archived_at IS NULL
           WHERE pc.kabanda_id = $2 AND pc.archived_at IS NULL
             AND p.verification_status = 'field_verified'
           ORDER BY p.id, pc.created_at DESC, pc.id
           ON CONFLICT (raid_id, source_point_id) DO NOTHING`,
          [raid.id, raid.kabanda_id],
        )
        if (!snapshots.rowCount) {
          throw new RaidError(
            'RAID_POINTS_EMPTY',
            409,
            'Нет проверенных точек для старта рейда',
          )
        }
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
    reason: 'pause' | 'cancel' | 'handoff' | 'recover' | 'finish',
  ): Promise<void> {
    await client.query(
      `UPDATE raid_navigator_leases SET ended_at = clock_timestamp(), ended_reason = $2,
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
      `UPDATE raid_activity_windows SET closed_at = clock_timestamp(), closed_version = $2
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

  private async pendingCounts(client: PoolClient, raidId: string): Promise<RaidPendingCounts> {
    const result = await client.query<{
      claims: string
      fallbacks: string
      media: string
    }>(
      `SELECT
         (SELECT count(*)::text FROM raid_checkin_claims
          WHERE raid_id = $1 AND status = 'pending' AND expires_at > clock_timestamp()) AS claims,
         (SELECT count(*)::text FROM raid_checkin_fallbacks
          WHERE raid_id = $1 AND status = 'pending_verifier'
            AND expires_at > clock_timestamp()) AS fallbacks,
         (SELECT count(*)::text FROM raid_media WHERE raid_id = $1 AND (
            state = 'processing' OR
            (state = 'pending_upload' AND upload_expires_at > clock_timestamp())
          )) AS media`,
      [raidId],
    )
    const row = result.rows[0]!
    return {
      claims: Number(row.claims),
      fallbacks: Number(row.fallbacks),
      media: Number(row.media),
    }
  }

  private async finalizationProjection(
    client: PoolClient,
    raidId: string,
  ): Promise<RaidFinalizationProjection> {
    const result = await client.query<{
      finalization_deadline_at: Date
      finalization_partial: boolean
      deadline_elapsed: boolean
    }>(
      `SELECT finalization_deadline_at, finalization_partial,
         finalization_deadline_at <= clock_timestamp() AS deadline_elapsed FROM raids
       WHERE id = $1 AND state = 'finalizing'`,
      [raidId],
    )
    const row = result.rows[0]
    if (!row?.finalization_deadline_at) throw new Error('Finalizing raid has no deadline')
    const pendingCounts = await this.pendingCounts(client, raidId)
    return {
      status: 'collecting',
      partial: row.finalization_partial,
      pendingCounts,
      deadlineAt: row.finalization_deadline_at.toISOString(),
      canSettle:
        row.deadline_elapsed ||
        pendingCounts.claims + pendingCounts.fallbacks + pendingCounts.media === 0,
    }
  }

  private async expireFinalizationTail(client: PoolClient, raidId: string): Promise<number> {
    const claims = await client.query(
      `UPDATE raid_checkin_claims SET status = 'expired_finalization', responded_at = now()
       WHERE raid_id = $1 AND status = 'pending'`,
      [raidId],
    )
    const fallbacks = await client.query(
      `UPDATE raid_checkin_fallbacks SET status = 'expired_finalization', responded_at = now()
       WHERE raid_id = $1 AND status = 'pending_verifier'`,
      [raidId],
    )
    const media = await client.query(
      `UPDATE raid_media SET state = 'expired_finalization', content_bytes = NULL,
         processing_started_at = NULL, processing_token = NULL
       WHERE raid_id = $1 AND state IN ('pending_upload', 'processing')`,
      [raidId],
    )
    return (claims.rowCount ?? 0) + (fallbacks.rowCount ?? 0) + (media.rowCount ?? 0)
  }

  private async buildImmutableResult(
    client: PoolClient,
    raid: RaidRow,
    completedAt: Date,
    actorUserId: string,
  ): Promise<RaidResult> {
    if (!raid.started_at || !raid.finalizing_at) throw new Error('Raid timing is incomplete')
    const teamResult = await client.query<{
      duration_seconds: number
      distance_meters: number
      unique_points: number
      photos: number
    }>(
      `WITH ordered AS (
         SELECT s.lease_id, s.sequence, s.captured_at, s.geom, s.accuracy_m,
           lag(s.sequence) OVER (PARTITION BY s.lease_id ORDER BY s.sequence) AS previous_sequence,
           lag(s.captured_at) OVER (PARTITION BY s.lease_id ORDER BY s.sequence) AS previous_at,
           lag(s.geom) OVER (PARTITION BY s.lease_id ORDER BY s.sequence) AS previous_geom,
           lag(s.accuracy_m) OVER (PARTITION BY s.lease_id ORDER BY s.sequence) AS previous_accuracy
         FROM raid_route_samples s
         JOIN raid_route_finalization_cutoffs c
           ON c.raid_id = s.raid_id AND c.lease_id = s.lease_id
            AND s.sequence <= c.max_sequence
         WHERE s.raid_id = $1
       ), segments AS (
         SELECT *, ST_Distance(geom, previous_geom) AS meters,
           extract(epoch FROM (captured_at - previous_at)) AS seconds
         FROM ordered WHERE previous_geom IS NOT NULL
       )
       SELECT
         (SELECT floor(coalesce(sum(extract(epoch FROM (closed_at - opened_at))), 0))
          FROM raid_activity_windows WHERE raid_id = $1) AS duration_seconds,
         (SELECT coalesce(sum(meters), 0) FROM segments
          WHERE accuracy_m <= 50 AND previous_accuracy <= 50
            AND sequence = previous_sequence + 1
            AND seconds > 0 AND seconds <= 120 AND meters <= 2000
            AND meters / seconds <= 50
            AND EXISTS (SELECT 1 FROM raid_activity_windows w
              WHERE w.raid_id = $1 AND previous_at >= w.opened_at
                AND captured_at <= w.closed_at)) AS distance_meters,
         (SELECT count(DISTINCT point_snapshot_id) FROM raid_point_credits
          WHERE raid_id = $1) AS unique_points,
         (SELECT count(*) FROM raid_media
          WHERE raid_id = $1 AND state = 'ready' AND ready_at <= $2) AS photos`,
      [raid.id, completedAt],
    )
    const participantResult = await client.query<{
      user_id: string
      display_name: string
      duration_seconds: number
      distance_meters: number
      unique_points: number
      photos: number
    }>(
      `WITH ordered AS (
         SELECT s.lease_id, s.sequence, s.captured_at, s.geom, s.accuracy_m,
           lag(s.sequence) OVER (PARTITION BY s.lease_id ORDER BY s.sequence) AS previous_sequence,
           lag(s.captured_at) OVER (PARTITION BY s.lease_id ORDER BY s.sequence) AS previous_at,
           lag(s.geom) OVER (PARTITION BY s.lease_id ORDER BY s.sequence) AS previous_geom,
           lag(s.accuracy_m) OVER (PARTITION BY s.lease_id ORDER BY s.sequence) AS previous_accuracy
         FROM raid_route_samples s
         JOIN raid_route_finalization_cutoffs c
           ON c.raid_id = s.raid_id AND c.lease_id = s.lease_id
            AND s.sequence <= c.max_sequence
         WHERE s.raid_id = $1
       ), segments AS (
         SELECT *, ST_Distance(geom, previous_geom) AS meters,
           extract(epoch FROM (captured_at - previous_at)) AS seconds
         FROM ordered WHERE previous_geom IS NOT NULL
       ), valid_segments AS (
         SELECT * FROM segments WHERE accuracy_m <= 50 AND previous_accuracy <= 50
           AND sequence = previous_sequence + 1
           AND seconds > 0 AND seconds <= 120 AND meters <= 2000
           AND meters / seconds <= 50
           AND EXISTS (SELECT 1 FROM raid_activity_windows w
             WHERE w.raid_id = $1 AND previous_at >= w.opened_at
               AND captured_at <= w.closed_at)
       )
       SELECT p.user_id,
         coalesce(u.display_name, u.username::text, split_part(u.email::text, '@', 1)) AS display_name,
         (SELECT floor(coalesce(sum(greatest(0, extract(epoch FROM (
            least(w.closed_at, coalesce(p.left_at, $2)) -
            greatest(w.opened_at, p.active_from)
          )))), 0)) FROM raid_activity_windows w
          WHERE w.raid_id = p.raid_id AND w.closed_at > p.active_from
            AND w.opened_at < coalesce(p.left_at, $2))
         AS duration_seconds,
         (SELECT coalesce(sum(s.meters), 0) FROM valid_segments s
          WHERE s.previous_at >= p.active_from
            AND s.captured_at <= coalesce(p.left_at, $2))
          AS distance_meters,
         (SELECT count(DISTINCT c.point_snapshot_id) FROM raid_point_credits c
          WHERE c.raid_id = p.raid_id AND c.user_id = p.user_id
            AND c.created_at BETWEEN p.active_from AND coalesce(p.left_at, $2)) AS unique_points,
         (SELECT count(*) FROM raid_media m WHERE m.raid_id = p.raid_id
          AND m.uploader_user_id = p.user_id AND m.state = 'ready'
          AND m.ready_at BETWEEN p.active_from AND coalesce(p.left_at, $2)) AS photos
       FROM raid_participants p
       JOIN users u ON u.id = p.user_id
       WHERE p.raid_id = $1 AND p.active_from IS NOT NULL
       ORDER BY p.active_from, p.user_id`,
      [raid.id, completedAt],
    )
    const team = this.metrics(teamResult.rows[0]!)
    const participants = participantResult.rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      metrics: this.metrics(row),
    }))
    const personal = participants.find((participant) => participant.userId === actorUserId)?.metrics ?? {
      durationSeconds: 0,
      distanceMeters: 0,
      uniquePoints: 0,
      photos: 0,
    }
    return {
      schemaVersion: 1,
      raid: {
        id: raid.id,
        kabandaId: raid.kabanda_id,
        title: raid.title,
        startedAt: raid.started_at.toISOString(),
        completedAt: completedAt.toISOString(),
        partial: raid.finalization_partial,
      },
      team,
      personal,
      participants,
    }
  }

  private async storeImmutableResult(
    client: PoolClient,
    result: RaidResult,
    sharePng: Buffer,
  ): Promise<void> {
    await client.query(
      `INSERT INTO raid_results
        (raid_id, kabanda_id, schema_version, partial, started_at, completed_at,
         team_duration_seconds, team_distance_meters, team_unique_points, team_photos,
         result_json, share_png, share_sha256)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        result.raid.id,
        result.raid.kabandaId,
        result.raid.partial,
        result.raid.startedAt,
        result.raid.completedAt,
        result.team.durationSeconds,
        result.team.distanceMeters,
        result.team.uniquePoints,
        result.team.photos,
        result,
        sharePng,
        createHash('sha256').update(sharePng).digest('hex'),
      ],
    )
    for (const participant of result.participants) {
      await client.query(
        `INSERT INTO raid_result_participants
          (raid_id, user_id, display_name, duration_seconds, distance_meters,
           unique_points, photos)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          result.raid.id,
          participant.userId,
          participant.displayName,
          participant.metrics.durationSeconds,
          participant.metrics.distanceMeters,
          participant.metrics.uniquePoints,
          participant.metrics.photos,
        ],
      )
    }
    await client.query(
      `INSERT INTO raid_result_points (raid_id, user_id, source_point_id)
       SELECT DISTINCT c.raid_id, c.user_id, s.source_point_id
       FROM raid_point_credits c
       JOIN raid_point_snapshots s ON s.id = c.point_snapshot_id
       JOIN raid_participants p ON p.raid_id = c.raid_id AND p.user_id = c.user_id
       WHERE c.raid_id = $1 AND p.active_from IS NOT NULL
         AND c.created_at BETWEEN p.active_from AND coalesce(p.left_at, $2)`,
      [result.raid.id, result.raid.completedAt],
    )
  }

  private metrics(row: {
    duration_seconds?: number | string | null
    distance_meters?: number | string | null
    unique_points?: number | string | null
    photos?: number | string | null
  }): RaidMetrics {
    return {
      durationSeconds: Number(row.duration_seconds ?? 0),
      distanceMeters: this.roundDistance(Number(row.distance_meters ?? 0)),
      uniquePoints: Number(row.unique_points ?? 0),
      photos: Number(row.photos ?? 0),
    }
  }

  private roundDistance(value: number): number {
    return Math.round(Number(value) * 10) / 10
  }

  private async requireKabandaMembership(actorUserId: string, kabandaId: string): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM kabanda_memberships m JOIN kabandas k ON k.id = m.kabanda_id
       WHERE m.kabanda_id = $1 AND m.user_id = $2 AND m.removed_at IS NULL
         AND k.archived_at IS NULL`,
      [kabandaId, actorUserId],
    )
    if (!result.rowCount) throw this.notFound()
  }

  private historyCursor(cursor?: string): { completedAt: string; raidId: string } | null {
    if (!cursor) return null
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        completedAt: string
        raidId: string
      }
      if (
        Number.isNaN(new Date(parsed.completedAt).getTime()) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          parsed.raidId,
        )
      ) {
        throw new Error('invalid')
      }
      return parsed
    } catch {
      throw new RaidError('HISTORY_CURSOR_INVALID', 400, 'Некорректный cursor')
    }
  }

  private requireVersion(raid: RaidRow, expectedVersion: number): void {
    if (raid.version !== expectedVersion) {
      throw new RaidError('RAID_VERSION_CONFLICT', 409, 'Рейд уже изменился', {
        currentVersion: raid.version,
        currentState: raid.state,
      })
    }
  }

  private invalidTransition(raid: RaidRow): RaidError {
    return new RaidError('RAID_TRANSITION_INVALID', 409, 'Команда недоступна в текущем состоянии', {
      currentVersion: raid.version,
      currentState: raid.state,
    })
  }

  private requireActiveParticipant(raid: RaidRow): void {
    if (raid.state !== 'active' || raid.participant_state !== 'active') {
      throw new RaidError('CHECKIN_UNAVAILABLE', 409, 'Отметка доступна только в активном рейде')
    }
  }

  private requireFinalizationCommitParticipant(raid: RaidRow): void {
    if (raid.participant_state !== 'active') {
      throw new RaidError('CHECKIN_UNAVAILABLE', 409, 'Операция участника недоступна')
    }
    if (raid.state === 'active') return
    if (
      raid.state === 'finalizing' &&
      raid.finalization_deadline_at &&
      raid.finalization_deadline_at.getTime() > raid.server_now.getTime()
    ) {
      return
    }
    throw new RaidError('FINALIZATION_CLOSED', 409, 'Окно завершения уже закрыто')
  }

  private async requireRaidParticipants(
    client: PoolClient,
    raid: RaidRow,
    userIds: string[],
  ): Promise<void> {
    if (userIds.length === 0) return
    const result = await client.query<{ user_id: string }>(
      `SELECT p.user_id FROM raid_participants p
       JOIN kabanda_memberships m
         ON m.kabanda_id = $2 AND m.user_id = p.user_id AND m.removed_at IS NULL
       WHERE p.raid_id = $1 AND p.user_id = ANY($3::uuid[]) AND p.state = 'active'`,
      [raid.id, raid.kabanda_id, userIds],
    )
    if (result.rows.length !== userIds.length) throw this.notFound()
  }

  private async insertCredits(
    client: PoolClient,
    raidId: string,
    pointSnapshotId: string,
    attemptId: string,
    userIds: string[],
    source: CreditProjection['source'],
  ): Promise<CreditProjection[]> {
    if (userIds.length === 0) return []
    const result = await client.query<{
      id: string
      user_id: string
      point_snapshot_id: string
      source: CreditProjection['source']
      created_at: Date
    }>(
      `INSERT INTO raid_point_credits
        (raid_id, point_snapshot_id, user_id, source, evidence_attempt_id)
       SELECT $1, $2, x.user_id, $5, $3 FROM unnest($4::uuid[]) x(user_id)
       ON CONFLICT (raid_id, point_snapshot_id, user_id) DO NOTHING
       RETURNING id, user_id, point_snapshot_id, source, created_at`,
      [raidId, pointSnapshotId, attemptId, [...new Set(userIds)], source],
    )
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      pointSnapshotId: row.point_snapshot_id,
      source: row.source,
      creditedAt: row.created_at.toISOString(),
    }))
  }

  private async insertClaims(
    client: PoolClient,
    raidId: string,
    attemptId: string,
    userIds: string[],
  ): Promise<ClaimProjection[]> {
    const result = await client.query(
      `INSERT INTO raid_checkin_claims (raid_id, attempt_id, user_id)
       SELECT $1, $2, x.user_id FROM unnest($3::uuid[]) x(user_id)
       ON CONFLICT (attempt_id, user_id) DO NOTHING
       RETURNING id, attempt_id, user_id, status, expires_at,
         expires_at <= clock_timestamp() AS expired`,
      [raidId, attemptId, userIds],
    )
    return result.rows.map((row) => this.claimProjection(row))
  }

  private claimProjection(row: {
    id: string
    attempt_id: string
    user_id: string
    status: string
    expires_at: Date
    expired: boolean
  }): ClaimProjection {
    return {
      id: row.id,
      attemptId: row.attempt_id,
      userId: row.user_id,
      status: resolveExpiringStatus(
        row.status,
        'pending',
        row.expired,
      ) as ClaimProjection['status'],
      expiresAt: row.expires_at.toISOString(),
    }
  }

  private fallbackProjection(row: {
    id: string
    attempt_id: string
    media_id: string
    verifier_user_id: string
    status: string
    reason: string
    expires_at: Date
    expired: boolean
  }): FallbackProjection {
    return {
      id: row.id,
      attemptId: row.attempt_id,
      mediaId: row.media_id,
      verifierUserId: row.verifier_user_id,
      status: resolveExpiringStatus(
        row.status,
        'pending_verifier',
        row.expired,
      ) as FallbackProjection['status'],
      reason: row.reason,
      expiresAt: row.expires_at.toISOString(),
    }
  }

  private mediaProjection(row: {
    id: string
    uploader_user_id: string
    state: string
    content_type: string
    size_bytes: number
    width: number
    height: number
    caption: string | null
    purpose: 'gallery' | 'fallback'
    created_at: Date
  }): MediaProjection {
    return {
      id: row.id,
      uploaderUserId: row.uploader_user_id,
      state: 'ready',
      contentType: 'image/jpeg',
      sizeBytes: Number(row.size_bytes),
      width: row.width,
      height: row.height,
      caption: row.caption,
      purpose: row.purpose,
      createdAt: row.created_at.toISOString(),
    }
  }

  private async mediaProjectionById(
    actorUserId: string,
    raidId: string,
    mediaId: string,
  ): Promise<MediaProjection> {
    const client = await this.pool.connect()
    try {
      await this.visibleRaid(client, actorUserId, raidId)
      const result = await client.query(
        `SELECT id, uploader_user_id, state, content_type, size_bytes, width, height,
           caption, purpose, created_at FROM raid_media
         WHERE id = $1 AND raid_id = $2 AND state = 'ready'`,
        [mediaId, raidId],
      )
      if (!result.rows[0]) throw this.notFound()
      return this.mediaProjection(result.rows[0])
    } finally {
      client.release()
    }
  }

  private secretHash(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }

  private async lockRaid(client: PoolClient, actorUserId: string, raidId: string): Promise<RaidRow> {
    const result = await client.query<RaidRow>(
      `SELECT r.id, r.kabanda_id, r.organizer_user_id, r.navigator_user_id,
         r.title, r.description, r.scheduled_at, r.started_at, r.finalizing_at,
         r.finalization_deadline_at, r.finalization_partial, clock_timestamp() AS server_now,
         r.state, r.version,
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

  private async visibleRaidProjection(
    client: PoolClient,
    actorUserId: string,
    raidId: string,
  ): Promise<void> {
    const result = await client.query<{
      state: RaidState
      role: 'owner' | 'member'
      participant_state: RaidParticipantState | null
    }>(
      `SELECT r.state, m.role, p.state AS participant_state FROM raids r
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
      (access.state !== 'completed' &&
        access.role !== 'owner' &&
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
         r.title, r.description, r.scheduled_at, r.started_at, r.finalizing_at,
         r.finalization_deadline_at, r.finalization_partial, clock_timestamp() AS server_now,
         r.state, r.version,
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
      `SELECT u.id, coalesce(u.display_name, u.username::text, split_part(u.email::text, '@', 1)) AS display_name,
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
    const finalization =
      raid.state === 'finalizing'
        ? await this.finalizationProjection(client, raid.id)
        : null
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
      finalization,
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
        isOrganizer: raid.organizer_user_id === actorUserId,
        participantState: raid.participant_state,
        navigatorReady,
        finalizationCanSettle: finalization?.canSettle ?? false,
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
      response:
        | RaidCommandResponse
        | RaidReadinessResponse
        | RaidLeaseResponse
        | FinishRaidResponse
        | SettleRaidResponse
        | { raid: RaidProjection }
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

  private async storeFeatureReceipt(
    client: PoolClient,
    actorUserId: string,
    operationId: string,
    raidId: string,
    command: string,
    requestFingerprint: string,
    response: unknown,
  ): Promise<void> {
    await client.query(
      `INSERT INTO raid_feature_receipts
        (actor_user_id, operation_id, raid_id, command, request_fingerprint, response_json)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actorUserId, operationId, raidId, command, requestFingerprint, response],
    )
  }

  private async replayFeature<T>(
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
      `SELECT fr.request_fingerprint, fr.response_json,
         (k.archived_at IS NULL AND m.user_id IS NOT NULL) AS access_active
       FROM raid_feature_receipts fr
       JOIN raids r ON r.id = fr.raid_id
       JOIN kabandas k ON k.id = r.kabanda_id
       LEFT JOIN kabanda_memberships m
         ON m.kabanda_id = r.kabanda_id AND m.user_id = fr.actor_user_id
           AND m.removed_at IS NULL
       WHERE fr.actor_user_id = $1 AND fr.operation_id = $2`,
      [actorUserId, operationId],
    )
    const receipt = result.rows[0]
    if (receipt) {
      if (!receipt.access_active) throw this.notFound()
      if (receipt.request_fingerprint !== requestFingerprint) {
        throw new RaidError('IDEMPOTENCY_CONFLICT', 409, 'Ключ уже использован')
      }
      return receipt.response_json
    }
    const other = await client.query<{ access_active: boolean }>(
      `SELECT (k.archived_at IS NULL AND m.user_id IS NOT NULL) AS access_active
       FROM (
         SELECT raid_id FROM raid_command_receipts WHERE actor_user_id = $1 AND operation_id = $2
         UNION ALL
         SELECT raid_id FROM raid_route_batch_receipts WHERE actor_user_id = $1 AND operation_id = $2
       ) old
       JOIN raids r ON r.id = old.raid_id JOIN kabandas k ON k.id = r.kabanda_id
       LEFT JOIN kabanda_memberships m
         ON m.kabanda_id = r.kabanda_id AND m.user_id = $1 AND m.removed_at IS NULL
       LIMIT 1`,
      [actorUserId, operationId],
    )
    if (!other.rows[0]) return null
    if (!other.rows[0].access_active) throw this.notFound()
    throw new RaidError('IDEMPOTENCY_CONFLICT', 409, 'Ключ уже использован')
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
         FROM (
           SELECT raid_id FROM raid_command_receipts WHERE actor_user_id = $1 AND operation_id = $2
           UNION ALL
           SELECT raid_id FROM raid_feature_receipts WHERE actor_user_id = $1 AND operation_id = $2
         ) rc
         JOIN raids r ON r.id = rc.raid_id
         JOIN kabandas k ON k.id = r.kabanda_id
         LEFT JOIN kabanda_memberships m
           ON m.kabanda_id = r.kabanda_id AND m.user_id = $1
             AND m.removed_at IS NULL
         LIMIT 1`,
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
         FROM (
           SELECT raid_id FROM raid_route_batch_receipts WHERE actor_user_id = $1 AND operation_id = $2
           UNION ALL
           SELECT raid_id FROM raid_feature_receipts WHERE actor_user_id = $1 AND operation_id = $2
         ) b
         JOIN raids r ON r.id = b.raid_id
         JOIN kabandas k ON k.id = r.kabanda_id
         LEFT JOIN kabanda_memberships m
           ON m.kabanda_id = r.kabanda_id AND m.user_id = $1
             AND m.removed_at IS NULL
         LIMIT 1`,
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
    if (raid.organizer_user_id !== actorUserId) {
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
