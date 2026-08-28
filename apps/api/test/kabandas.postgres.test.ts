import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { DatabaseKabandaService, KabandaError, type ManifestPoint } from '../src/kabandas.js'
import { DatabaseRaidService } from '../src/raids.js'

const databaseUrl = process.env.DATABASE_URL
const describePostgres = databaseUrl ? describe : describe.skip
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null
const service = pool ? new DatabaseKabandaService(pool) : null
const raidService = pool ? new DatabaseRaidService(pool) : null

const bounds = { minLat: 56.8, minLon: 53.1, maxLat: 56.9, maxLon: 53.3 }
const manifest: ManifestPoint[] = [
  {
    stableKey: 'izh-test-one',
    name: 'Точка один',
    latitude: 56.85,
    longitude: 53.2,
    source: 'OpenStreetMap',
    sourceId: 'node/test-one',
    sourceUrl: 'https://www.openstreetmap.org/node/test-one',
    license: 'ODbL-1.0',
    verificationStatus: 'source_checked',
    verifiedAt: '2026-08-28',
    notes: '',
  },
  {
    stableKey: 'izh-test-two',
    name: 'Точка два',
    latitude: 56.86,
    longitude: 53.21,
    source: 'OpenStreetMap',
    sourceId: 'node/test-two',
    sourceUrl: 'https://www.openstreetmap.org/node/test-two',
    license: 'ODbL-1.0',
    verificationStatus: 'field_verified',
    verifiedAt: '2026-08-28',
    notes: '',
  },
]

async function user(email: string): Promise<string> {
  const result = await pool!.query<{ id: string }>(
    'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
    [email, email.split('@')[0]],
  )
  return result.rows[0]!.id
}

async function ownerAndKabanda(suffix: string) {
  const ownerId = await user(`owner-${suffix}@example.com`)
  const kabanda = await service!.createKabanda(ownerId, `Кабанда ${suffix}`, '🐗', `create-${suffix}`)
  return { ownerId, kabanda }
}

function readiness(online = true) {
  const measuredAt = new Date().toISOString()
  return {
    appMode: 'standalone' as const,
    locationPermission: 'granted' as const,
    coordinateMeasuredAt: measuredAt,
    accuracyM: 12,
    indexedDbWritable: true,
    storageAvailable: true,
    online,
    measuredAt,
  }
}

async function readyRaid(ownerId: string, kabandaId: string, suffix: string) {
  const created = await raidService!.createDraft(
    ownerId,
    kabandaId,
    { title: `Рейд ${suffix}` },
    `raid-create-${suffix}`,
  )
  const raidId = created.raid.id
  await raidService!.command(ownerId, raidId, 'open-lobby', { expectedVersion: 1 }, `lobby-${suffix}`)
  await raidService!.command(
    ownerId,
    raidId,
    'assign-navigator',
    { expectedVersion: 2, navigatorUserId: ownerId },
    `navigator-${suffix}`,
  )
  const ready = await raidService!.command(
    ownerId,
    raidId,
    'ready',
    { expectedVersion: 3 },
    `ready-${suffix}`,
  )
  return raidService!.reportReadiness(
    ownerId,
    raidId,
    { expectedVersion: ready.raid.version, ...readiness() },
    `readiness-${suffix}`,
  )
}

async function activeOwnerRaid(ownerId: string, kabandaId: string, suffix: string) {
  const ready = await readyRaid(ownerId, kabandaId, suffix)
  const started = await raidService!.command(
    ownerId,
    ready.raid.id,
    'start',
    { expectedVersion: ready.raid.version },
    `start-${suffix}`,
  )
  const clientInstanceId = randomUUID()
  const acquired = await raidService!.acquireNavigatorLease(
    ownerId,
    started.raid.id,
    { expectedVersion: started.raid.version, clientInstanceId },
    `acquire-${suffix}`,
  )
  return { acquired, clientInstanceId, leaseId: acquired.raid.navigatorLease!.id }
}

describePostgres('Kabandas and points PostgreSQL invariants', () => {
  beforeEach(async () => {
    await pool!.query(
      `TRUNCATE point_import_reports, point_visits, collection_points, points,
       point_collections, invite_acceptances, invite_continuations, kabanda_invites,
       kabanda_memberships, kabandas, auth_sessions, auth_magic_links, users CASCADE`,
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('creates one Kabanda for concurrent requests with the same idempotency key', async () => {
    const ownerId = await user('owner@example.com')
    const results = await Promise.all([
      service!.createKabanda(ownerId, 'Ночные кабаны', '🌙', 'create-same'),
      service!.createKabanda(ownerId, 'Ночные кабаны', '🌙', 'create-same'),
    ])
    expect(new Set(results.map(({ id }) => id)).size).toBe(1)
    expect(Number((await pool!.query('SELECT count(*) FROM kabandas')).rows[0]?.count)).toBe(1)
    expect(Number((await pool!.query('SELECT count(*) FROM kabanda_memberships')).rows[0]?.count)).toBe(1)
  })

  it('rejects forged, expired, revoked and replayed invite material', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('invites')
    await expect(service!.previewInvite('forged-token-that-is-at-least-32-chars', true)).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })

    await Promise.all([
      service!.createInvite(ownerId, kabanda.id, 1),
      service!.createInvite(ownerId, kabanda.id, 1),
    ])
    expect(
      Number(
        (
          await pool!.query(
            `SELECT count(*) FROM kabanda_invites
             WHERE kabanda_id = $1 AND revoked_at IS NULL AND consumed_at IS NULL`,
            [kabanda.id],
          )
        ).rows[0]?.count,
      ),
    ).toBe(1)

    const expired = await service!.createInvite(ownerId, kabanda.id, 1)
    await pool!.query('UPDATE kabanda_invites SET expires_at = now() - interval \'1 minute\' WHERE id = $1', [
      expired.id,
    ])
    await expect(service!.previewInvite(expired.token, true)).rejects.toBeInstanceOf(KabandaError)

    const revoked = await service!.createInvite(ownerId, kabanda.id, 1)
    await service!.revokeInvite(ownerId, kabanda.id, revoked.id)
    await expect(service!.previewInvite(revoked.token, true)).rejects.toBeInstanceOf(KabandaError)

    const valid = await service!.createInvite(ownerId, kabanda.id, 1)
    const preview = await service!.previewInvite(valid.token, true)
    expect((await service!.previewContinuation(preview.continuation, false)).continuation).toBe(
      preview.continuation,
    )
    const memberId = await user('member@example.com')
    const [accepted, replay] = await Promise.all([
      service!.acceptInvite(memberId, preview.continuation, 'accept-once'),
      service!.acceptInvite(memberId, preview.continuation, 'accept-once'),
    ])
    expect(replay.id).toBe(accepted.id)
    await expect(
      service!.previewContinuation(preview.continuation, false, memberId),
    ).resolves.toMatchObject({ accepted: true, kabanda: { id: accepted.id } })
    await expect(
      service!.acceptInvite(memberId, preview.continuation, 'accept-different'),
    ).rejects.toMatchObject({ code: 'INVITE_INVALID' })

    const revokedAfterPreview = await service!.createInvite(ownerId, kabanda.id, 1)
    const revokedContinuation = await service!.previewInvite(revokedAfterPreview.token, true)
    await service!.revokeInvite(ownerId, kabanda.id, revokedAfterPreview.id)
    await expect(
      service!.previewContinuation(revokedContinuation.continuation, false),
    ).rejects.toMatchObject({ code: 'INVITE_INVALID' })
  })

  it('isolates cross-Kabanda direct IDs and removes access immediately', async () => {
    const first = await ownerAndKabanda('first')
    const second = await ownerAndKabanda('second')
    const imported = await service!.importManifest(
      first.ownerId,
      first.kabanda.id,
      'manifest-v1',
      'a'.repeat(64),
      'Ижевск alpha',
      manifest,
    )
    await expect(service!.listMembers(second.ownerId, first.kabanda.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(
      service!.listPoints(second.ownerId, imported.collectionId, bounds, 100),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const memberId = await user('removed@example.com')
    const invite = await service!.createInvite(first.ownerId, first.kabanda.id, 1)
    const preview = await service!.previewInvite(invite.token, true)
    await service!.acceptInvite(memberId, preview.continuation, 'accept-member')
    expect((await service!.listPoints(memberId, imported.collectionId, bounds, 100)).points).toHaveLength(2)
    await service!.removeMember(first.ownerId, first.kabanda.id, memberId)
    await expect(service!.listMembers(memberId, first.kabanda.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(
      service!.listPoints(memberId, imported.collectionId, bounds, 100),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('replays one alpha import and keeps point IDs and visit history stable across rename/archive', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('import')
    const [first, replay] = await Promise.all([
      service!.importManifest(
        ownerId,
        kabanda.id,
        'manifest-v1',
        'b'.repeat(64),
        'Ижевск alpha',
        manifest,
      ),
      service!.importManifest(
        ownerId,
        kabanda.id,
        'manifest-v1',
        'b'.repeat(64),
        'Ижевск alpha',
        manifest,
      ),
    ])
    expect(first.reportId).toBe(replay.reportId)
    expect([first.replayed, replay.replayed].sort()).toEqual([false, true])
    expect(Number((await pool!.query('SELECT count(*) FROM points')).rows[0]?.count)).toBe(2)

    const pointId = (await service!.listPoints(ownerId, first.collectionId, bounds, 100)).points[0]!
      .id as string
    await service!.recordVisit(ownerId, kabanda.id, pointId, 'visit-stable')
    await service!.updatePoint(ownerId, kabanda.id, pointId, 'Новое имя', true)
    const history = await pool!.query<{
      point_id: string
      point_name_snapshot: string
      longitude: number
      latitude: number
    }>(
      `SELECT point_id, point_name_snapshot,
         ST_X(point_location_snapshot)::float8 AS longitude,
         ST_Y(point_location_snapshot)::float8 AS latitude
       FROM point_visits WHERE user_id = $1`,
      [ownerId],
    )
    expect(history.rows[0]).toMatchObject({
      point_id: pointId,
      point_name_snapshot: 'Точка один',
      longitude: 53.2,
      latitude: 56.85,
    })
    expect((await service!.listPoints(ownerId, first.collectionId, bounds, 100)).points).toHaveLength(1)
  })

  it('keeps equal stable point keys isolated between Kabandas', async () => {
    const first = await ownerAndKabanda('tenant-a')
    const second = await ownerAndKabanda('tenant-b')
    const firstImport = await service!.importManifest(
      first.ownerId,
      first.kabanda.id,
      'manifest-v1',
      'c'.repeat(64),
      'Ижевск A',
      manifest,
    )
    const secondManifest = manifest.map((point, index) =>
      index === 0 ? { ...point, name: 'Чужое новое имя', longitude: 53.24 } : point,
    )
    const secondImport = await service!.importManifest(
      second.ownerId,
      second.kabanda.id,
      'manifest-v1',
      'd'.repeat(64),
      'Ижевск B',
      secondManifest,
    )

    const firstPoints = await service!.listPoints(first.ownerId, firstImport.collectionId, bounds, 100)
    const secondPoints = await service!.listPoints(second.ownerId, secondImport.collectionId, bounds, 100)
    expect(firstPoints.points[0]).toMatchObject({ name: 'Точка один', longitude: 53.2 })
    expect(secondPoints.points[0]).toMatchObject({ name: 'Чужое новое имя', longitude: 53.24 })
    expect(firstPoints.points[0]!.id).not.toBe(secondPoints.points[0]!.id)

    await service!.updatePoint(
      second.ownerId,
      second.kabanda.id,
      secondPoints.points[0]!.id as string,
      'Архив B',
      true,
    )
    await expect(
      service!.listPoints(first.ownerId, firstImport.collectionId, bounds, 100),
    ).resolves.toMatchObject({ points: [{ name: 'Точка один' }, { name: 'Точка два' }] })
  })

  it('rejects an oversized bbox before querying points', async () => {
    const ownerId = await user('bbox@example.com')
    await expect(
      service!.listPoints(
        ownerId,
        '81297402-898c-48d6-bc78-c74b6b38205c',
        { minLat: 56.7, minLon: 53, maxLat: 57, maxLon: 53.4 },
        100,
      ),
    ).rejects.toMatchObject({ code: 'BBOX_INVALID' })
  })

  it('runs the server-owned lobby, readiness, start, pause, resume and cancel lifecycle', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('raid-happy')
    const ready = await readyRaid(ownerId, kabanda.id, 'happy')
    expect(ready.raid).toMatchObject({ state: 'lobby', version: 4, navigatorReady: true })
    expect(ready.raid.allowedActions).toContain('start')

    const started = await raidService!.command(
      ownerId,
      ready.raid.id,
      'start',
      { expectedVersion: 4 },
      'start-happy',
    )
    expect(started.raid).toMatchObject({ state: 'active', version: 5 })
    await expect(raidService!.getCurrent(ownerId)).resolves.toMatchObject({ id: ready.raid.id })

    const paused = await raidService!.command(
      ownerId,
      ready.raid.id,
      'pause',
      { expectedVersion: 5 },
      'pause-happy',
    )
    const resumed = await raidService!.command(
      ownerId,
      ready.raid.id,
      'resume',
      { expectedVersion: paused.raid.version },
      'resume-happy',
    )
    const cancelled = await raidService!.command(
      ownerId,
      ready.raid.id,
      'cancel',
      { expectedVersion: resumed.raid.version },
      'cancel-happy',
    )
    expect(cancelled.raid).toMatchObject({ state: 'cancelled', version: 8 })
    await expect(raidService!.getCurrent(ownerId)).resolves.toBeNull()
  })

  it('creates a future scheduled raid as planned and opens its lobby', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('raid-planned')
    const scheduledAt = '2099-08-28T12:00:00.000Z'
    const created = await raidService!.createDraft(
      ownerId,
      kabanda.id,
      { title: 'Scheduled ride', scheduledAt },
      'planned-create-operation',
    )
    expect(created.receipt.command).toBe('create-raid')
    expect(created.raid).toMatchObject({ state: 'planned', version: 1, scheduledAt })
    const immediate = await raidService!.createDraft(
      ownerId,
      kabanda.id,
      { title: 'Ride now' },
      'draft-create-operation',
    )
    expect(immediate.raid).toMatchObject({ state: 'draft', version: 1, scheduledAt: null })

    const lobby = await raidService!.command(
      ownerId,
      created.raid.id,
      'open-lobby',
      { expectedVersion: 1 },
      'planned-open-lobby',
    )
    expect(lobby.raid).toMatchObject({ state: 'lobby', version: 2, scheduledAt })
  })

  it('returns an immutable canonical replay and rejects a reused key or stale version', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('raid-replay')
    const created = await raidService!.createDraft(
      ownerId,
      kabanda.id,
      { title: 'Replay ride' },
      'create-replay',
    )
    const [first, duplicate] = await Promise.all([
      raidService!.command(
        ownerId,
        created.raid.id,
        'open-lobby',
        { expectedVersion: 1 },
        'same-lobby-operation',
      ),
      raidService!.command(
        ownerId,
        created.raid.id,
        'open-lobby',
        { expectedVersion: 1 },
        'same-lobby-operation',
      ),
    ])
    expect(duplicate).toEqual(first)
    await raidService!.command(
      ownerId,
      created.raid.id,
      'cancel',
      { expectedVersion: 2 },
      'cancel-after-replay',
    )
    await expect(
      raidService!.command(
        ownerId,
        created.raid.id,
        'open-lobby',
        { expectedVersion: 1 },
        'same-lobby-operation',
      ),
    ).resolves.toEqual(first)
    await expect(
      raidService!.command(
        ownerId,
        created.raid.id,
        'cancel',
        { expectedVersion: 2 },
        'same-lobby-operation',
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(
      raidService!.command(
        ownerId,
        created.raid.id,
        'cancel',
        { expectedVersion: 1 },
        'stale-cancel-operation',
      ),
    ).rejects.toMatchObject({ code: 'RAID_VERSION_CONFLICT' })
    expect(
      Number(
        (
          await pool!.query(
            `SELECT count(*) FROM raid_command_receipts
             WHERE raid_id = $1 AND command = 'open-lobby'`,
            [created.raid.id],
          )
        ).rows[0]?.count,
      ),
    ).toBe(1)
  })

  it('lets an accepted non-navigator become ready exactly once', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('raid-member-ready')
    const memberId = await user('raid-ready-member@example.com')
    const invite = await service!.createInvite(ownerId, kabanda.id, 1)
    const preview = await service!.previewInvite(invite.token, true)
    await service!.acceptInvite(memberId, preview.continuation, 'ready-member-membership')

    const created = await raidService!.createDraft(
      ownerId,
      kabanda.id,
      { title: 'Everyone can be ready' },
      'member-ready-create',
    )
    await raidService!.command(
      ownerId,
      created.raid.id,
      'open-lobby',
      { expectedVersion: 1 },
      'member-ready-lobby',
    )
    await raidService!.command(
      memberId,
      created.raid.id,
      'accept',
      { expectedVersion: 2 },
      'member-ready-accept',
    )
    await raidService!.command(
      ownerId,
      created.raid.id,
      'assign-navigator',
      { expectedVersion: 3, navigatorUserId: ownerId },
      'member-ready-navigator',
    )

    const ready = await raidService!.command(
      memberId,
      created.raid.id,
      'ready',
      { expectedVersion: 4 },
      'member-ready-once',
    )
    expect(ready.raid.navigatorUserId).toBe(ownerId)
    expect(ready.raid.participants).toContainEqual(
      expect.objectContaining({ id: memberId, state: 'ready' }),
    )
    expect(ready.raid.allowedActions).not.toContain('ready')
    await expect(
      raidService!.command(
        memberId,
        created.raid.id,
        'ready',
        { expectedVersion: 5 },
        'member-ready-twice',
      ),
    ).rejects.toMatchObject({ code: 'RAID_COMMAND_FORBIDDEN' })
  })

  it('allows one winner for two-tab start and only one active raid per Kabanda', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('raid-race')
    const first = await readyRaid(ownerId, kabanda.id, 'race-first')
    const startResults = await Promise.allSettled([
      raidService!.command(
        ownerId,
        first.raid.id,
        'start',
        { expectedVersion: 4 },
        'start-tab-one',
      ),
      raidService!.command(
        ownerId,
        first.raid.id,
        'start',
        { expectedVersion: 4 },
        'start-tab-two',
      ),
    ])
    expect(startResults.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(startResults.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(Number((await pool!.query("SELECT count(*) FROM raids WHERE state = 'active'")).rows[0]?.count)).toBe(1)

    const second = await readyRaid(ownerId, kabanda.id, 'race-second')
    await expect(
      raidService!.command(
        ownerId,
        second.raid.id,
        'start',
        { expectedVersion: 4 },
        'start-second-raid',
      ),
    ).rejects.toMatchObject({ code: 'ACTIVE_RAID_EXISTS' })
  })

  it('invalidates stale readiness, blocks offline readiness and hides cross-tenant raid IDs', async () => {
    const first = await ownerAndKabanda('raid-tenant-a')
    const second = await ownerAndKabanda('raid-tenant-b')
    const created = await raidService!.createDraft(
      first.ownerId,
      first.kabanda.id,
      { title: 'Private ride' },
      'private-create',
    )
    await raidService!.command(
      first.ownerId,
      created.raid.id,
      'open-lobby',
      { expectedVersion: 1 },
      'private-lobby',
    )
    await raidService!.command(
      first.ownerId,
      created.raid.id,
      'assign-navigator',
      { expectedVersion: 2, navigatorUserId: first.ownerId },
      'private-navigator',
    )
    const participantReady = await raidService!.command(
      first.ownerId,
      created.raid.id,
      'ready',
      { expectedVersion: 3 },
      'private-participant-ready',
    )
    const offlineReport = { expectedVersion: participantReady.raid.version, ...readiness(false) }
    const blocked = await raidService!.reportReadiness(
      first.ownerId,
      created.raid.id,
      offlineReport,
      'private-offline-ready',
    )
    await expect(
      raidService!.reportReadiness(
        first.ownerId,
        created.raid.id,
        offlineReport,
        'private-offline-ready',
      ),
    ).resolves.toEqual(blocked)
    expect(blocked.report).toMatchObject({ status: 'fail', raidVersion: 4 })
    expect(blocked.raid.navigatorReady).toBe(false)
    await expect(
      raidService!.command(
        first.ownerId,
        created.raid.id,
        'start',
        { expectedVersion: 4 },
        'private-blocked-start',
      ),
    ).rejects.toMatchObject({ code: 'NAVIGATOR_NOT_READY' })
    const recovered = await raidService!.reportReadiness(
      first.ownerId,
      created.raid.id,
      { expectedVersion: 4, ...readiness(true), storageAvailable: null },
      'private-online-ready',
    )
    expect(recovered.report).toMatchObject({ status: 'warn', raidVersion: 4 })
    expect(recovered.report.blockers).not.toContain('STORAGE_UNAVAILABLE')
    expect(recovered.raid).toMatchObject({ version: 4, navigatorReady: true })
    expect(recovered.raid.navigatorWarnings).toContain('STORAGE_UNKNOWN')

    await expect(raidService!.getRaid(second.ownerId, created.raid.id)).rejects.toMatchObject({
      code: 'RAID_NOT_FOUND',
    })
    await expect(
      raidService!.listActionable(second.ownerId, first.kabanda.id),
    ).rejects.toMatchObject({ code: 'RAID_NOT_FOUND' })
  })

  it('accepts reordered route samples once and replays an immutable batch receipt', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('route-batch')
    const { acquired, clientInstanceId, leaseId } = await activeOwnerRaid(
      ownerId,
      kabanda.id,
      'route-batch',
    )
    const capturedAt = new Date().toISOString()
    const firstInput = {
      schemaVersion: 1 as const,
      leaseId,
      clientInstanceId,
      samples: [
        {
          operationId: 'route-sample-three',
          sequence: 3,
          capturedAt,
          latitude: 56.85,
          longitude: 53.2,
          accuracyM: 8,
        },
        {
          operationId: 'route-sample-one',
          sequence: 1,
          capturedAt,
          latitude: 56.8501,
          longitude: 53.2001,
          accuracyM: 8,
        },
      ],
    }
    const first = await raidService!.submitRouteBatch(
      ownerId,
      acquired.raid.id,
      firstInput,
      'route-batch-first',
    )
    expect(first.batchId).toBe('route-batch-first')
    await expect(
      raidService!.submitRouteBatch(
        ownerId,
        acquired.raid.id,
        firstInput,
        'route-batch-first',
      ),
    ).resolves.toEqual(first)
    await expect(
      raidService!.command(
        ownerId,
        acquired.raid.id,
        'pause',
        { expectedVersion: acquired.raid.version },
        'route-batch-first',
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await raidService!.acquireNavigatorLease(
      ownerId,
      acquired.raid.id,
      { expectedVersion: acquired.raid.version, clientInstanceId },
      'route-command-shared-key',
    )
    await expect(
      raidService!.submitRouteBatch(
        ownerId,
        acquired.raid.id,
        {
          schemaVersion: 1,
          leaseId,
          clientInstanceId,
          samples: [{
            operationId: 'route-cross-namespace-sample',
            sequence: 4,
            capturedAt: new Date().toISOString(),
            latitude: 56.85,
            longitude: 53.2,
            accuracyM: 8,
          }],
        },
        'route-command-shared-key',
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(first.accepted).toHaveLength(2)
    expect(first.routeStatus).toMatchObject({ status: 'fresh', missingSequenceCount: 1 })

    const filled = await raidService!.submitRouteBatch(
      ownerId,
      acquired.raid.id,
      {
        schemaVersion: 1,
        leaseId,
        clientInstanceId,
        samples: [
          {
            operationId: 'route-sample-two',
            sequence: 2,
            capturedAt: new Date().toISOString(),
            latitude: 56.8502,
            longitude: 53.2002,
            accuracyM: 8,
          },
        ],
      },
      'route-batch-fill-gap',
    )
    expect(filled.routeStatus.missingSequenceCount).toBe(0)
    await expect(
      raidService!.submitRouteBatch(
        ownerId,
        acquired.raid.id,
        {
          schemaVersion: 1,
          leaseId,
          clientInstanceId,
          samples: [
            {
              operationId: 'route-sample-two-conflict',
              sequence: 2,
              capturedAt: new Date().toISOString(),
              latitude: 56.86,
              longitude: 53.21,
              accuracyM: 9,
            },
          ],
        },
        'route-batch-conflict',
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_SAMPLE_CONFLICT' })
    await expect(
      raidService!.submitRouteBatch(
        ownerId,
        acquired.raid.id,
        {
          schemaVersion: 1,
          leaseId,
          clientInstanceId,
          samples: [
            {
              operationId: 'route-outside-izhevsk',
              sequence: 4,
              capturedAt: new Date().toISOString(),
              latitude: 55.75,
              longitude: 37.62,
              accuracyM: 8,
            },
          ],
        },
        'route-batch-outside',
      ),
    ).rejects.toMatchObject({ code: '23514' })
    expect(
      Number(
        (
          await pool!.query('SELECT count(*) FROM raid_route_samples WHERE raid_id = $1', [
            acquired.raid.id,
          ])
        ).rows[0]?.count,
      ),
    ).toBe(3)
  })

  it('closes route leases across pause, resume and explicit recovery', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('route-cutover')
    const active = await activeOwnerRaid(ownerId, kabanda.id, 'route-cutover')
    const paused = await raidService!.command(
      ownerId,
      active.acquired.raid.id,
      'pause',
      { expectedVersion: active.acquired.raid.version },
      'route-pause-cutover',
    )
    expect(paused.raid.routeStatus.status).toBe('paused')
    await expect(
      raidService!.submitRouteBatch(
        ownerId,
        paused.raid.id,
        {
          schemaVersion: 1,
          leaseId: active.leaseId,
          clientInstanceId: active.clientInstanceId,
          samples: [
            {
              operationId: 'paused-old-sample',
              sequence: 1,
              capturedAt: new Date().toISOString(),
              latitude: 56.85,
              longitude: 53.2,
              accuracyM: 8,
            },
          ],
        },
        'paused-old-batch',
      ),
    ).rejects.toMatchObject({ code: 'NAVIGATOR_LEASE_SUPERSEDED' })

    const resumed = await raidService!.command(
      ownerId,
      paused.raid.id,
      'resume',
      { expectedVersion: paused.raid.version },
      'route-resume-generation',
    )
    expect(resumed.raid.routeStatus.status).toBe('awaiting_lease')
    expect(resumed.raid.navigatorLease!.generation).toBe(2)
    await expect(
      raidService!.submitRouteBatch(
        ownerId,
        resumed.raid.id,
        {
          schemaVersion: 1,
          leaseId: active.leaseId,
          clientInstanceId: active.clientInstanceId,
          samples: [
            {
              operationId: 'resumed-old-sample',
              sequence: 1,
              capturedAt: new Date().toISOString(),
              latitude: 56.85,
              longitude: 53.2,
              accuracyM: 8,
            },
          ],
        },
        'resumed-old-batch',
      ),
    ).rejects.toMatchObject({ code: 'NAVIGATOR_LEASE_SUPERSEDED' })

    const nextClient = randomUUID()
    const acquired = await raidService!.acquireNavigatorLease(
      ownerId,
      resumed.raid.id,
      { expectedVersion: resumed.raid.version, clientInstanceId: nextClient },
      'route-acquire-after-resume',
    )
    const recoveredClient = randomUUID()
    const recovered = await raidService!.recoverNavigatorLease(
      ownerId,
      resumed.raid.id,
      { expectedVersion: resumed.raid.version, clientInstanceId: recoveredClient },
      'route-explicit-recover',
    )
    expect(recovered.raid.navigatorLease!.generation).toBe(3)
    await expect(
      raidService!.submitRouteBatch(
        ownerId,
        resumed.raid.id,
        {
          schemaVersion: 1,
          leaseId: acquired.raid.navigatorLease!.id,
          clientInstanceId: nextClient,
          samples: [
            {
              operationId: 'recovered-old-sample',
              sequence: 1,
              capturedAt: new Date().toISOString(),
              latitude: 56.85,
              longitude: 53.2,
              accuracyM: 8,
            },
          ],
        },
        'recovered-old-batch',
      ),
    ).rejects.toMatchObject({ code: 'NAVIGATOR_LEASE_SUPERSEDED' })
  })

  it('cuts over handoff atomically and privacy-gates a removed navigator receipt', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('route-handoff')
    const memberId = await user('route-handoff-member@example.com')
    const invite = await service!.createInvite(ownerId, kabanda.id, 1)
    const preview = await service!.previewInvite(invite.token, true)
    await service!.acceptInvite(memberId, preview.continuation, 'handoff-member-join')
    const created = await raidService!.createDraft(
      ownerId,
      kabanda.id,
      { title: 'Handoff route' },
      'handoff-route-create',
    )
    await raidService!.command(
      ownerId,
      created.raid.id,
      'open-lobby',
      { expectedVersion: 1 },
      'handoff-route-lobby',
    )
    await raidService!.command(
      memberId,
      created.raid.id,
      'accept',
      { expectedVersion: 2 },
      'handoff-route-accept',
    )
    await raidService!.command(
      ownerId,
      created.raid.id,
      'assign-navigator',
      { expectedVersion: 3, navigatorUserId: ownerId },
      'handoff-route-initial-nav',
    )
    await raidService!.command(
      ownerId,
      created.raid.id,
      'ready',
      { expectedVersion: 4 },
      'handoff-route-ready',
    )
    await raidService!.reportReadiness(
      ownerId,
      created.raid.id,
      { expectedVersion: 5, ...readiness() },
      'handoff-route-readiness',
    )
    const started = await raidService!.command(
      ownerId,
      created.raid.id,
      'start',
      { expectedVersion: 5 },
      'handoff-route-start',
    )
    const ownerClient = randomUUID()
    const ownerLease = await raidService!.acquireNavigatorLease(
      ownerId,
      created.raid.id,
      { expectedVersion: 6, clientInstanceId: ownerClient },
      'handoff-route-owner-acquire',
    )
    const handedOff = await raidService!.command(
      ownerId,
      created.raid.id,
      'handoff-navigator',
      { expectedVersion: 6, navigatorUserId: memberId },
      'handoff-route-command',
    )
    expect(handedOff.raid).toMatchObject({ version: 7, navigatorUserId: memberId })
    await expect(
      raidService!.submitRouteBatch(
        ownerId,
        created.raid.id,
        {
          schemaVersion: 1,
          leaseId: ownerLease.raid.navigatorLease!.id,
          clientInstanceId: ownerClient,
          samples: [
            {
              operationId: 'handoff-old-operation',
              sequence: 1,
              capturedAt: new Date().toISOString(),
              latitude: 56.85,
              longitude: 53.2,
              accuracyM: 8,
            },
          ],
        },
        'handoff-old-batch',
      ),
    ).rejects.toMatchObject({ code: 'NAVIGATOR_LEASE_SUPERSEDED' })

    const memberClients = [randomUUID(), randomUUID()]
    const claims = await Promise.allSettled(
      memberClients.map((clientInstanceId, index) =>
        raidService!.acquireNavigatorLease(
          memberId,
          created.raid.id,
          { expectedVersion: 7, clientInstanceId },
          `handoff-member-acquire-${index}`,
        ),
      ),
    )
    expect(claims.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(claims.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    const winnerIndex = claims.findIndex(({ status }) => status === 'fulfilled')
    const memberClient = memberClients[winnerIndex]!
    const winner = claims[winnerIndex]
    if (!winner || winner.status !== 'fulfilled') throw new Error('Lease claim had no winner')
    const memberLease = winner.value
    const memberInput = {
      schemaVersion: 1 as const,
      leaseId: memberLease.raid.navigatorLease!.id,
      clientInstanceId: memberClient,
      samples: [
        {
          operationId: 'handoff-member-operation',
          sequence: 1,
          capturedAt: new Date().toISOString(),
          latitude: 56.851,
          longitude: 53.201,
          accuracyM: 7,
        },
      ],
    }
    const memberBatch = await raidService!.submitRouteBatch(
      memberId,
      created.raid.id,
      memberInput,
      'handoff-member-batch',
    )
    expect(memberBatch.accepted).toHaveLength(1)
    await service!.removeMember(ownerId, kabanda.id, memberId)
    await expect(
      raidService!.submitRouteBatch(
        memberId,
        created.raid.id,
        memberInput,
        'handoff-member-batch',
      ),
    ).rejects.toMatchObject({ code: 'RAID_NOT_FOUND' })
    expect(started.raid.routeStatus.status).toBe('awaiting_lease')
  })

  it('does not replay a private receipt after membership removal', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('raid-removed-replay')
    const memberId = await user('raid-removed-member@example.com')
    const invite = await service!.createInvite(ownerId, kabanda.id, 1)
    const preview = await service!.previewInvite(invite.token, true)
    await service!.acceptInvite(memberId, preview.continuation, 'raid-member-accept')

    const created = await raidService!.createDraft(
      ownerId,
      kabanda.id,
      { title: 'Private replay' },
      'private-replay-create',
    )
    await raidService!.command(
      ownerId,
      created.raid.id,
      'open-lobby',
      { expectedVersion: 1 },
      'private-replay-lobby',
    )
    const accepted = await raidService!.command(
      memberId,
      created.raid.id,
      'accept',
      { expectedVersion: 2 },
      'private-member-accept',
    )
    expect(accepted.raid.version).toBe(3)

    await service!.removeMember(ownerId, kabanda.id, memberId)
    await expect(
      raidService!.command(
        memberId,
        created.raid.id,
        'accept',
        { expectedVersion: 2 },
        'private-member-accept',
      ),
    ).rejects.toMatchObject({ code: 'RAID_NOT_FOUND' })
  })
})
