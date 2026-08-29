import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import sharp from 'sharp'
import { DatabaseKabandaService, KabandaError, type ManifestPoint } from '../src/kabandas.js'
import { DatabaseRaidService } from '../src/raids.js'

const databaseUrl = process.env.DATABASE_URL
const describePostgres = databaseUrl ? describe : describe.skip
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null
const service = pool ? new DatabaseKabandaService(pool) : null
const mediaCapabilitySecret = 'test-media-capability-secret-at-least-32-bytes'
const raidService = pool
  ? new DatabaseRaidService(pool, mediaCapabilitySecret)
  : null

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
  await service!.importManifest(
    ownerId,
    kabandaId,
    `raid-points-${suffix}`,
    createHash('sha256').update(`raid-points-${suffix}`).digest('hex'),
    `Рейдовые точки ${suffix}`,
    manifest,
  )
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

  it('registers exactly one credential identity for concurrent acceptance of one invite', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('credential-invite')
    const invite = await service!.createInvite(ownerId, kabanda.id, 1)
    const preview = await service!.previewInvite(invite.token, true)
    const attempts = await Promise.allSettled([
      service!.acceptInviteWithCredentials(preview.continuation, 'credential-accept-1', {
        username: 'night-boar',
        passwordHash: 'scrypt$test-hash',
      }),
      service!.acceptInviteWithCredentials(preview.continuation, 'credential-accept-1', {
        username: 'night-boar',
        passwordHash: 'scrypt$test-hash',
      }),
    ])
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(Number((await pool!.query("SELECT count(*) FROM users WHERE identity_kind = 'invite'")).rows[0]?.count)).toBe(1)
    expect(Number((await pool!.query("SELECT count(*) FROM kabanda_memberships WHERE role = 'member'")).rows[0]?.count)).toBe(1)
    expect(Number((await pool!.query('SELECT count(*) FROM auth_sessions')).rows[0]?.count)).toBe(1)
    expect(Number((await pool!.query('SELECT count(*) FROM invite_acceptances')).rows[0]?.count)).toBe(1)
  })

  it('keeps an invite unconsumed when the requested username is already taken', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('credential-conflict')
    await pool!.query(
      `INSERT INTO users (email, username, password_hash, identity_kind, display_name)
       VALUES (NULL, 'taken-name', 'scrypt$existing', 'invite', 'taken-name')`,
    )
    const invite = await service!.createInvite(ownerId, kabanda.id, 1)
    const preview = await service!.previewInvite(invite.token, true)
    await expect(service!.acceptInviteWithCredentials(preview.continuation, 'credential-conflict-1', {
      username: 'TAKEN-NAME',
      passwordHash: 'scrypt$new',
    })).rejects.toMatchObject({ code: 'REGISTRATION_UNAVAILABLE' })
    await expect(service!.previewContinuation(preview.continuation, true)).resolves.toMatchObject({
      accepted: false,
    })
  })

  it('serializes credential invites at the closed-alpha 20-user cap', async () => {
    const secret = 'invite-cap-secret-at-least-32-characters'
    const enforced = new DatabaseKabandaService(pool!, {
      alphaAccessMode: 'enforced',
      alphaAccessSecret: secret,
      sessionTtlDays: 30,
    })
    const ownerId = await user('owner-invite-cap@example.com')
    await pool!.query(
      `INSERT INTO alpha_access_grants (email_fingerprint, user_id, status)
       VALUES ($1, $2, 'active')`,
      ['0'.repeat(64), ownerId],
    )
    for (let index = 1; index < 19; index += 1) {
      await pool!.query(
        `INSERT INTO alpha_access_grants (email_fingerprint, status)
         VALUES ($1, 'active')`,
        [index.toString(16).padStart(64, '0')],
      )
    }
    const firstKabanda = await enforced.createKabanda(ownerId, 'Лимит один', '🐗', 'cap-create-1')
    const secondKabanda = await enforced.createKabanda(ownerId, 'Лимит два', '🐗', 'cap-create-2')
    const first = await enforced.previewInvite(
      (await enforced.createInvite(ownerId, firstKabanda.id, 1)).token,
      true,
    )
    const second = await enforced.previewInvite(
      (await enforced.createInvite(ownerId, secondKabanda.id, 1)).token,
      true,
    )
    const attempts = await Promise.allSettled([
      enforced.acceptInviteWithCredentials(first.continuation, 'cap-accept-1', {
        username: 'cap-boar-one', passwordHash: 'scrypt$one',
      }),
      enforced.acceptInviteWithCredentials(second.continuation, 'cap-accept-2', {
        username: 'cap-boar-two', passwordHash: 'scrypt$two',
      }),
    ])
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(Number((await pool!.query("SELECT count(*) FROM alpha_access_grants WHERE status = 'active'")).rows[0]?.count)).toBe(20)
    expect(Number((await pool!.query("SELECT count(*) FROM users WHERE identity_kind = 'invite'")).rows[0]?.count)).toBe(1)
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
    await expect(
      raidService!.recoverNavigatorLease(
        ownerId,
        resumed.raid.id,
        { expectedVersion: resumed.raid.version, clientInstanceId: nextClient },
        'route-recover-same-client',
      ),
    ).rejects.toMatchObject({ code: 'NAVIGATOR_LEASE_ALREADY_CURRENT' })
    const unchanged = await raidService!.getRaid(ownerId, resumed.raid.id)
    expect(unchanged.navigatorLease).toEqual(acquired.raid.navigatorLease)
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
    await service!.importManifest(
      ownerId,
      kabanda.id,
      'raid-points-route-handoff',
      createHash('sha256').update('raid-points-route-handoff').digest('hex'),
      'Рейдовые точки handoff',
      manifest,
    )
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

  it('freezes field-verified points and issues one idempotent GPS credit', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('checkin-snapshot')
    const { acquired } = await activeOwnerRaid(ownerId, kabanda.id, 'checkin-snapshot')
    const snapshots = await pool!.query<{
      id: string
      source_point_id: string
      name: string
    }>('SELECT id, source_point_id, name FROM raid_point_snapshots WHERE raid_id = $1', [
      acquired.raid.id,
    ])
    expect(snapshots.rows).toHaveLength(1)
    expect(snapshots.rows[0]!.name).toBe('Точка два')

    await pool!.query(
      `UPDATE points SET name = 'Переименованная точка', archived_at = now()
       WHERE id = $1`,
      [snapshots.rows[0]!.source_point_id],
    )
    const nearby = await raidService!.nearbyCheckins(ownerId, acquired.raid.id, {
      latitude: 56.86,
      longitude: 53.21,
      limit: 5,
    })
    expect(nearby.points).toEqual([
      expect.objectContaining({ name: 'Точка два', creditedByMe: false }),
    ])

    const input = {
      pointSnapshotId: snapshots.rows[0]!.id,
      evidence: {
        latitude: 56.86,
        longitude: 53.21,
        capturedAt: new Date().toISOString(),
        accuracyMeters: 12,
      },
      presentParticipantIds: [],
      organizerAttestation: false,
    }
    const accepted = await raidService!.createCheckin(
      ownerId,
      acquired.raid.id,
      input,
      'checkin-snapshot-once',
    )
    await expect(
      raidService!.createCheckin(ownerId, acquired.raid.id, input, 'checkin-snapshot-once'),
    ).resolves.toEqual(accepted)
    expect(accepted).toMatchObject({ outcome: 'accepted', reason: null })
    expect(accepted.credits).toHaveLength(1)
    await expect(
      raidService!.createCheckin(
        ownerId,
        acquired.raid.id,
        { ...input, evidence: { ...input.evidence, accuracyMeters: 99 } },
        'checkin-snapshot-once',
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(
      Number(
        (
          await pool!.query(
            'SELECT count(*) FROM raid_point_credits WHERE raid_id = $1',
            [acquired.raid.id],
          )
        ).rows[0]!.count,
      ),
    ).toBe(1)

    const late = await raidService!.createCheckin(
      ownerId,
      acquired.raid.id,
      {
        ...input,
        evidence: {
          ...input.evidence,
          capturedAt: new Date(Date.now() - 61_000).toISOString(),
        },
      },
      'checkin-snapshot-late',
    )
    expect(late).toMatchObject({
      outcome: 'needs_manual_verification',
      reason: 'location_expired',
      credits: [],
    })

    const invalidAttestations = [
      {
        operationId: 'checkin-attestation-expired',
        reason: 'location_expired',
        evidence: {
          ...input.evidence,
          capturedAt: new Date(Date.now() - 61_000).toISOString(),
        },
      },
      {
        operationId: 'checkin-attestation-inaccurate',
        reason: 'accuracy_insufficient',
        evidence: {
          ...input.evidence,
          capturedAt: new Date().toISOString(),
          accuracyMeters: 51,
        },
      },
      {
        operationId: 'checkin-attestation-too-far',
        reason: 'too_far',
        evidence: {
          ...input.evidence,
          latitude: 56.87,
          capturedAt: new Date().toISOString(),
        },
      },
    ] as const
    for (const invalid of invalidAttestations) {
      const result = await raidService!.createCheckin(
        ownerId,
        acquired.raid.id,
        {
          ...input,
          evidence: invalid.evidence,
          organizerAttestation: true,
        },
        invalid.operationId,
      )
      expect(result).toMatchObject({
        outcome: 'needs_manual_verification',
        reason: invalid.reason,
        credits: [],
      })
    }
  })

  it('confirms private claims and a same-raid sanitized media fallback', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('checkin-media')
    const { acquired } = await activeOwnerRaid(ownerId, kabanda.id, 'checkin-media')
    const memberId = await user('checkin-media-member@example.com')
    await pool!.query(
      `INSERT INTO kabanda_memberships (kabanda_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [kabanda.id, memberId],
    )
    await pool!.query(
      `INSERT INTO raid_participants (raid_id, user_id, state, accepted_at, active_from)
       VALUES ($1, $2, 'active', now(), now())`,
      [acquired.raid.id, memberId],
    )
    const snapshot = (
      await pool!.query<{ id: string }>(
        'SELECT id FROM raid_point_snapshots WHERE raid_id = $1 LIMIT 1',
        [acquired.raid.id],
      )
    ).rows[0]!
    const manual = await raidService!.createCheckin(
      ownerId,
      acquired.raid.id,
      {
        pointSnapshotId: snapshot.id,
        evidence: {
          latitude: 56.86,
          longitude: 53.21,
          capturedAt: new Date(Date.now() - 120_000).toISOString(),
          accuracyMeters: 8,
        },
        presentParticipantIds: [],
        organizerAttestation: false,
      },
      'checkin-media-manual',
    )
    const source = await sharp({
      create: { width: 32, height: 24, channels: 3, background: '#7a3e18' },
    })
      .png()
      .toBuffer()
    const sourceSha256 = createHash('sha256').update(source).digest('hex')
    await pool!.query(
      `INSERT INTO raid_media
        (raid_id, uploader_user_id, purpose, source_sha256, declared_size_bytes,
         declared_content_type, upload_capability_hash, upload_expires_at)
       SELECT $1, $2, 'gallery', lpad(series::text, 64, '0'), 1, 'image/jpeg',
         lpad((series + 1000)::text, 64, '0'), now() - interval '1 minute'
       FROM generate_series(1, 100) AS series`,
      [acquired.raid.id, ownerId],
    )
    const intent = await raidService!.createMediaIntent(
      ownerId,
      acquired.raid.id,
      {
        sourceSha256,
        sizeBytes: source.length,
        contentType: 'image/png',
        caption: 'След кабана',
        purpose: 'fallback',
        attemptId: manual.attemptId,
      },
      'checkin-media-intent',
    )
    await expect(
      raidService!.createMediaIntent(
        ownerId,
        acquired.raid.id,
        {
          sourceSha256,
          sizeBytes: source.length,
          contentType: 'image/png',
          caption: 'След кабана',
          purpose: 'fallback',
          attemptId: manual.attemptId,
        },
        'checkin-media-intent',
      ),
    ).resolves.toEqual(intent)
    const intentReceipt = await pool!.query<{ response_json: Record<string, unknown> }>(
      `SELECT response_json FROM raid_feature_receipts
       WHERE actor_user_id = $1 AND operation_id = 'checkin-media-intent'`,
      [ownerId],
    )
    expect(intentReceipt.rows[0]!.response_json).not.toHaveProperty('uploadCapability')
    const uploaded = await raidService!.uploadMedia(
      ownerId,
      acquired.raid.id,
      intent.intentId,
      intent.uploadCapability,
      sourceSha256,
      source,
    )
    expect(uploaded.media).toMatchObject({ contentType: 'image/jpeg', state: 'ready' })
    const stored = await raidService!.readMedia(ownerId, acquired.raid.id, uploaded.media.id)
    expect((await sharp(stored.bytes).metadata()).exif).toBeUndefined()

    const fallbackInput = {
      attemptId: manual.attemptId,
      mediaId: uploaded.media.id,
      verifierUserId: memberId,
      presentParticipantIds: [],
      reason: 'Проверено на месте',
    }
    const competingFallbacks = await Promise.allSettled([
      raidService!.createFallback(
        ownerId,
        acquired.raid.id,
        fallbackInput,
        'checkin-media-fallback-a',
      ),
      raidService!.createFallback(
        ownerId,
        acquired.raid.id,
        fallbackInput,
        'checkin-media-fallback-b',
      ),
    ])
    const firstFallback = competingFallbacks.find((result) => result.status === 'fulfilled')
    const duplicateFallback = competingFallbacks.find((result) => result.status === 'rejected')
    if (firstFallback?.status !== 'fulfilled' || duplicateFallback?.status !== 'rejected') {
      throw new Error('Expected exactly one open fallback request')
    }
    expect(duplicateFallback.reason).toMatchObject({
      code: 'FALLBACK_ALREADY_REQUESTED',
      statusCode: 409,
    })
    await raidService!.respondFallback(
      memberId,
      acquired.raid.id,
      firstFallback.value.fallback.id,
      'decline',
      'checkin-media-fallback-decline',
    )
    const fallback = await raidService!.createFallback(
      ownerId,
      acquired.raid.id,
      fallbackInput,
      'checkin-media-fallback-after-decline',
    )
    await expect(
      raidService!.tombstoneMedia(
        ownerId,
        acquired.raid.id,
        uploaded.media.id,
        'checkin-media-delete-evidence',
      ),
    ).rejects.toMatchObject({ code: 'MEDIA_IS_FALLBACK_EVIDENCE' })
    await pool!.query(
      `UPDATE raid_media SET state = 'processing', processing_started_at = clock_timestamp(),
         processing_token = $2
       WHERE id = $1`,
      [uploaded.media.id, randomUUID()],
    )
    await expect(
      raidService!.respondFallback(
        memberId,
        acquired.raid.id,
        fallback.fallback.id,
        'confirm',
        'checkin-media-fallback-confirm',
      ),
    ).rejects.toMatchObject({ code: 'FALLBACK_MEDIA_UNAVAILABLE' })
    await pool!.query(
      `UPDATE raid_media SET state = 'ready', processing_started_at = NULL,
         processing_token = NULL WHERE id = $1`,
      [uploaded.media.id],
    )
    await pool!.query("UPDATE raid_media SET purpose = 'gallery' WHERE id = $1", [
      uploaded.media.id,
    ])
    await expect(
      raidService!.respondFallback(
        memberId,
        acquired.raid.id,
        fallback.fallback.id,
        'confirm',
        'checkin-media-fallback-confirm',
      ),
    ).rejects.toMatchObject({ code: 'FALLBACK_MEDIA_UNAVAILABLE' })
    await pool!.query("UPDATE raid_media SET purpose = 'fallback' WHERE id = $1", [
      uploaded.media.id,
    ])
    const verifierInbox = await raidService!.listPendingFallbacks(memberId, acquired.raid.id)
    expect(verifierInbox.fallbacks[0]!.id).toBe(fallback.fallback.id)
    const verified = await raidService!.respondFallback(
      memberId,
      acquired.raid.id,
      fallback.fallback.id,
      'confirm',
      'checkin-media-fallback-confirm',
    )
    expect(verified.credits).toEqual([
      expect.objectContaining({ userId: ownerId, source: 'media_fallback' }),
    ])
    await expect(
      raidService!.tombstoneMedia(
        ownerId,
        acquired.raid.id,
        uploaded.media.id,
        'checkin-media-delete-confirmed-evidence',
      ),
    ).rejects.toMatchObject({ code: 'MEDIA_IS_FALLBACK_EVIDENCE' })

    const accepted = await raidService!.createCheckin(
      ownerId,
      acquired.raid.id,
      {
        pointSnapshotId: snapshot.id,
        evidence: {
          latitude: 56.86,
          longitude: 53.21,
          capturedAt: new Date().toISOString(),
          accuracyMeters: 8,
        },
        presentParticipantIds: [memberId],
        organizerAttestation: false,
      },
      'checkin-media-claim',
    )
    expect(accepted.claims).toHaveLength(1)

    const acceptedSource = await sharp({
      create: { width: 24, height: 24, channels: 3, background: '#2b5d38' },
    })
      .png()
      .toBuffer()
    const acceptedSourceSha256 = createHash('sha256').update(acceptedSource).digest('hex')
    const acceptedIntent = await raidService!.createMediaIntent(
      ownerId,
      acquired.raid.id,
      {
        sourceSha256: acceptedSourceSha256,
        sizeBytes: acceptedSource.length,
        contentType: 'image/png',
        purpose: 'fallback',
        attemptId: accepted.attemptId,
      },
      'checkin-media-accepted-intent',
    )
    const acceptedMedia = await raidService!.uploadMedia(
      ownerId,
      acquired.raid.id,
      acceptedIntent.intentId,
      acceptedIntent.uploadCapability,
      acceptedSourceSha256,
      acceptedSource,
    )
    await expect(
      raidService!.createFallback(
        ownerId,
        acquired.raid.id,
        {
          attemptId: accepted.attemptId,
          mediaId: acceptedMedia.media.id,
          verifierUserId: memberId,
          presentParticipantIds: [],
          reason: 'Не должно пройти для обычной отметки',
        },
        'checkin-media-accepted-fallback',
      ),
    ).rejects.toMatchObject({ code: 'RAID_NOT_FOUND' })
    const inbox = await raidService!.listPendingClaims(memberId, acquired.raid.id)
    const confirmed = await raidService!.respondClaim(
      memberId,
      acquired.raid.id,
      inbox.claims[0]!.id,
      'confirm',
      'checkin-media-confirm-claim',
    )
    expect(confirmed.credit).toMatchObject({ userId: memberId, source: 'claim' })
  })

  it('fences stale media processors with a server-timed UUID claim token', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('media-fence')
    const { acquired } = await activeOwnerRaid(ownerId, kabanda.id, 'media-fence')

    for (const mode of ['commit', 'reset'] as const) {
      const source = await sharp({
        create: {
          width: 12,
          height: 12,
          channels: 3,
          background: mode === 'commit' ? '#245d3b' : '#7a3e18',
        },
      })
        .png()
        .toBuffer()
      const sourceSha256 = createHash('sha256').update(source).digest('hex')
      const intent = await raidService!.createMediaIntent(
        ownerId,
        acquired.raid.id,
        {
          sourceSha256,
          sizeBytes: source.length,
          contentType: 'image/png',
          purpose: 'gallery',
        },
        `media-fence-intent-${mode}`,
      )
      await pool!.query(
        `UPDATE raid_media SET state = 'processing',
           processing_started_at = clock_timestamp() - interval '3 minutes',
           processing_token = $2
         WHERE id = $1`,
        [intent.intentId, randomUUID()],
      )

      let enteredProcessor!: () => void
      const processorEntered = new Promise<void>((resolve) => {
        enteredProcessor = resolve
      })
      let releaseProcessor!: () => void
      const processorReleased = new Promise<void>((resolve) => {
        releaseProcessor = resolve
      })
      const delayedService = new DatabaseRaidService(
        pool!,
        mediaCapabilitySecret,
        async () => {
          enteredProcessor()
          await processorReleased
          if (mode === 'reset') throw new Error('synthetic processor failure')
          return {
            data: source,
            info: { width: 12, height: 12, size: source.length },
          }
        },
      )
      const upload = delayedService.uploadMedia(
        ownerId,
        acquired.raid.id,
        intent.intentId,
        intent.uploadCapability,
        sourceSha256,
        source,
      )
      await processorEntered
      const claimed = await pool!.query<{ processing_token: string }>(
        'SELECT processing_token FROM raid_media WHERE id = $1',
        [intent.intentId],
      )
      const firstToken = claimed.rows[0]!.processing_token
      const replacementToken = randomUUID()
      await pool!.query(
        `UPDATE raid_media SET processing_token = $2,
           processing_started_at = clock_timestamp()
         WHERE id = $1 AND processing_token = $3`,
        [intent.intentId, replacementToken, firstToken],
      )
      releaseProcessor()

      await expect(upload).rejects.toMatchObject({
        code: 'MEDIA_PROCESSING_SUPERSEDED',
        statusCode: 409,
      })
      const stored = await pool!.query<{
        state: string
        processing_token: string
        content_bytes: Buffer | null
      }>(
        `SELECT state, processing_token, content_bytes FROM raid_media WHERE id = $1`,
        [intent.intentId],
      )
      expect(stored.rows[0]).toMatchObject({
        state: 'processing',
        processing_token: replacementToken,
        content_bytes: null,
      })
    }
  })

  it('freezes one canonical result, participant cutoffs, history and private PNG', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('results')
    const { acquired, clientInstanceId, leaseId } = await activeOwnerRaid(
      ownerId,
      kabanda.id,
      'results',
    )
    const memberId = await user('results-member@example.com')
    await pool!.query(
      `INSERT INTO kabanda_memberships (kabanda_id, user_id, role) VALUES ($1, $2, 'member')`,
      [kabanda.id, memberId],
    )
    await pool!.query(
      `INSERT INTO raid_participants (raid_id, user_id, state, accepted_at, active_from)
       VALUES ($1, $2, 'active', now(), now())`,
      [acquired.raid.id, memberId],
    )
    await raidService!.submitRouteBatch(
      ownerId,
      acquired.raid.id,
      {
        schemaVersion: 1,
        leaseId,
        clientInstanceId,
        samples: [
          {
            operationId: 'result-route-sample-one',
            sequence: 1,
            capturedAt: new Date().toISOString(),
            latitude: 56.86,
            longitude: 53.21,
            accuracyM: 8,
          },
          {
            operationId: 'result-route-sample-two',
            sequence: 2,
            capturedAt: new Date(Date.now() + 1000).toISOString(),
            latitude: 56.8602,
            longitude: 53.211,
            accuracyM: 8,
          },
          {
            operationId: 'result-route-sample-four',
            sequence: 4,
            capturedAt: new Date(Date.now() + 2000).toISOString(),
            latitude: 56.8604,
            longitude: 53.212,
            accuracyM: 8,
          },
          {
            operationId: 'result-route-sample-five',
            sequence: 5,
            capturedAt: new Date(Date.now() + 3000).toISOString(),
            latitude: 56.8605,
            longitude: 53.2122,
            accuracyM: 8,
          },
        ],
      },
      'result-route-batch',
    )
    const snapshot = (
      await pool!.query<{ id: string }>(
        'SELECT id FROM raid_point_snapshots WHERE raid_id = $1 LIMIT 1',
        [acquired.raid.id],
      )
    ).rows[0]!
    await raidService!.createCheckin(
      ownerId,
      acquired.raid.id,
      {
        pointSnapshotId: snapshot.id,
        evidence: {
          latitude: 56.86,
          longitude: 53.21,
          capturedAt: new Date().toISOString(),
          accuracyMeters: 8,
        },
        presentParticipantIds: [memberId],
        organizerAttestation: true,
      },
      'result-checkin',
    )
    const mediaId = randomUUID()
    await pool!.query(
      `INSERT INTO raid_media
        (id, raid_id, uploader_user_id, purpose, source_sha256, declared_size_bytes,
         declared_content_type, upload_capability_hash, upload_expires_at, state,
         content_bytes, content_type, size_bytes, width, height, content_sha256, ready_at)
       VALUES ($1, $2, $3, 'gallery', $4, 4, 'image/jpeg', $5, now() + interval '1 minute',
         'ready', decode('ffd8ffd9', 'hex'), 'image/jpeg', 4, 1, 1, $6, now())`,
      [mediaId, acquired.raid.id, ownerId, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
    )
    await expect(
      raidService!.leaveRaid(
        ownerId,
        acquired.raid.id,
        acquired.raid.version,
        'result-owner-cannot-leave',
      ),
    ).rejects.toMatchObject({ code: 'RAID_COMMAND_FORBIDDEN' })
    const left = await raidService!.leaveRaid(
      memberId,
      acquired.raid.id,
      acquired.raid.version,
      'result-member-leave',
    )
    expect(left.raid.participants.find((participant) => participant.id === memberId)?.state).toBe(
      'left',
    )
    await expect(raidService!.getRaid(memberId, acquired.raid.id)).rejects.toMatchObject({
      code: 'RAID_NOT_FOUND',
    })
    const current = await raidService!.getRaid(ownerId, acquired.raid.id)
    const finish = await raidService!.finishRaid(
      ownerId,
      acquired.raid.id,
      {
        expectedVersion: current.version,
        inventory: { routePending: 0, checkInsPending: 0, mediaPending: 0, needsAction: 0 },
        confirmPartial: false,
      },
      'result-finish',
    )
    expect(finish.finalization).toMatchObject({ status: 'collecting', partial: false })
    const finalizationSeconds = Number(
      (
        await pool!.query(
          `SELECT extract(epoch FROM (finalization_deadline_at - finalizing_at)) AS seconds
           FROM raids WHERE id = $1`,
          [acquired.raid.id],
        )
      ).rows[0]!.seconds,
    )
    expect(finalizationSeconds).toBeGreaterThanOrEqual(119.9)
    expect(finalizationSeconds).toBeLessThanOrEqual(120.1)
    expect(
      Number(
        (
          await pool!.query(
            'SELECT count(*) FROM raid_route_finalization_cutoffs WHERE raid_id = $1',
            [acquired.raid.id],
          )
        ).rows[0]!.count,
      ),
    ).toBeGreaterThan(0)
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
              operationId: 'result-route-after-cutoff',
              sequence: 6,
              capturedAt: new Date().toISOString(),
              latitude: 56.8603,
              longitude: 53.2112,
              accuracyM: 8,
            },
          ],
        },
        'result-route-after-finish',
      ),
    ).rejects.toMatchObject({ code: 'NAVIGATOR_LEASE_SUPERSEDED' })

    await pool!.query(
      `UPDATE raids SET started_at = '2026-08-28T10:00:00Z',
         finalizing_at = '2026-08-28T11:00:00Z' WHERE id = $1`,
      [acquired.raid.id],
    )
    await pool!.query(
      `UPDATE raid_activity_windows SET opened_at = '2026-08-28T10:00:00Z',
         closed_at = '2026-08-28T10:30:00Z' WHERE raid_id = $1`,
      [acquired.raid.id],
    )
    await pool!.query(
      `INSERT INTO raid_activity_windows
        (raid_id, opened_at, closed_at, opened_version, closed_version)
       VALUES ($1, '2026-08-28T10:30:00Z', '2026-08-28T11:00:00Z', 100, 100)`,
      [acquired.raid.id],
    )
    await pool!.query(
      `UPDATE raid_participants SET active_from = '2026-08-28T10:00:00Z',
         left_at = CASE WHEN user_id = $2
           THEN '2026-08-28T10:30:00Z'::timestamptz ELSE NULL::timestamptz END
       WHERE raid_id = $1`,
      [acquired.raid.id, memberId],
    )
    await pool!.query(
      `UPDATE raid_route_samples SET
         captured_at = CASE sequence
           WHEN 1 THEN '2026-08-28T10:10:10Z'::timestamptz
           WHEN 2 THEN '2026-08-28T10:10:20Z'::timestamptz
           WHEN 4 THEN '2026-08-28T10:29:50Z'::timestamptz
           ELSE '2026-08-28T10:30:10Z'::timestamptz END,
         received_at = CASE sequence
           WHEN 1 THEN '2026-08-28T10:45:10Z'::timestamptz
           WHEN 2 THEN '2026-08-28T10:45:20Z'::timestamptz
           WHEN 4 THEN '2026-08-28T10:45:30Z'::timestamptz
           ELSE '2026-08-28T10:45:40Z'::timestamptz END
       WHERE raid_id = $1`,
      [acquired.raid.id],
    )
    await pool!.query(
      `UPDATE raid_point_credits SET created_at = '2026-08-28T10:20:00Z' WHERE raid_id = $1`,
      [acquired.raid.id],
    )
    await pool!.query(
      `UPDATE raid_media SET ready_at = '2026-08-28T10:20:00Z' WHERE id = $1`,
      [mediaId],
    )
    const expectedDistance = Number(
      (
        await pool!.query(
          `SELECT ST_Distance(a.geom, b.geom) AS meters FROM raid_route_samples a
           JOIN raid_route_samples b ON b.lease_id = a.lease_id AND b.sequence = 2
           WHERE a.lease_id = $1 AND a.sequence = 1`,
          [leaseId],
        )
      ).rows[0]!.meters,
    )
    const settled = await raidService!.settleFinalization(
      ownerId,
      acquired.raid.id,
      finish.raid.version,
      'result-settle',
    )
    expect(settled.result.team).toEqual({
      durationSeconds: 3600,
      distanceMeters: Math.round(expectedDistance * 10) / 10,
      uniquePoints: 1,
      photos: 1,
    })
    expect(
      settled.result.participants.find((participant) => participant.userId === memberId)?.metrics,
    ).toMatchObject({
      durationSeconds: 1800,
      distanceMeters: Math.round(expectedDistance * 10) / 10,
      uniquePoints: 1,
      photos: 0,
    })
    await expect(
      raidService!.settleFinalization(
        ownerId,
        acquired.raid.id,
        finish.raid.version,
        'result-settle',
      ),
    ).resolves.toEqual(settled)

    await pool!.query("UPDATE users SET display_name = 'Новое имя' WHERE id = $1", [ownerId])
    await pool!.query(
      `UPDATE raid_activity_windows SET opened_at = opened_at + interval '1 minute'
       WHERE raid_id = $1`,
      [acquired.raid.id],
    )
    await raidService!.tombstoneMedia(
      ownerId,
      acquired.raid.id,
      mediaId,
      'result-photo-tombstone',
    )
    const immutable = await raidService!.getResult(ownerId, acquired.raid.id)
    expect(immutable).toEqual(settled.result)
    expect(immutable.team.photos).toBe(1)
    await expect(
      pool!.query('UPDATE raid_results SET team_photos = 99 WHERE raid_id = $1', [
        acquired.raid.id,
      ]),
    ).rejects.toMatchObject({ code: '55000' })
    expect(immutable.participants.some((participant) => participant.displayName === 'Новое имя')).toBe(
      false,
    )
    await expect(raidService!.getRaid(memberId, acquired.raid.id)).resolves.toMatchObject({
      id: acquired.raid.id,
      state: 'completed',
    })
    const laterMemberId = await user('results-later-member@example.com')
    await pool!.query(
      `INSERT INTO kabanda_memberships (kabanda_id, user_id, role) VALUES ($1, $2, 'member')`,
      [kabanda.id, laterMemberId],
    )
    await expect(raidService!.getRaid(laterMemberId, acquired.raid.id)).resolves.toMatchObject({
      id: acquired.raid.id,
      state: 'completed',
    })
    expect((await raidService!.listHistory(laterMemberId, kabanda.id, 20)).raids[0]!.personal).toEqual({
      durationSeconds: 0,
      distanceMeters: 0,
      uniquePoints: 0,
      photos: 0,
    })
    const history = await raidService!.listHistory(ownerId, kabanda.id, 20)
    expect(history.raids[0]).toMatchObject({ raidId: acquired.raid.id, team: settled.result.team })
    const progress = await raidService!.getProgress(ownerId, kabanda.id)
    expect(progress.progress.team).toMatchObject({ completedRaids: 1, uniquePoints: 1, photos: 1 })
    const png = await raidService!.getShareCard(ownerId, acquired.raid.id)
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')

    const outsider = await ownerAndKabanda('results-outsider')
    await expect(raidService!.getResult(outsider.ownerId, acquired.raid.id)).rejects.toMatchObject({
      code: 'RAID_NOT_FOUND',
    })
  })

  it('serializes settle against finalizing claim and media commits', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('finalizing-race')
    const { acquired } = await activeOwnerRaid(ownerId, kabanda.id, 'finalizing-race')
    const memberId = await user('finalizing-race-member@example.com')
    await pool!.query(
      `INSERT INTO kabanda_memberships (kabanda_id, user_id, role) VALUES ($1, $2, 'member')`,
      [kabanda.id, memberId],
    )
    await pool!.query(
      `INSERT INTO raid_participants (raid_id, user_id, state, accepted_at, active_from)
       VALUES ($1, $2, 'active', now(), now())`,
      [acquired.raid.id, memberId],
    )
    const snapshot = (
      await pool!.query<{ id: string }>(
        'SELECT id FROM raid_point_snapshots WHERE raid_id = $1 LIMIT 1',
        [acquired.raid.id],
      )
    ).rows[0]!
    const checkin = await raidService!.createCheckin(
      ownerId,
      acquired.raid.id,
      {
        pointSnapshotId: snapshot.id,
        evidence: {
          latitude: 56.86,
          longitude: 53.21,
          capturedAt: new Date().toISOString(),
          accuracyMeters: 8,
        },
        presentParticipantIds: [memberId],
        organizerAttestation: false,
      },
      'finalizing-race-checkin',
    )
    const claimId = checkin.claims[0]!.id
    const source = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#315d42' },
    })
      .png()
      .toBuffer()
    const sourceSha = createHash('sha256').update(source).digest('hex')
    const intent = await raidService!.createMediaIntent(
      ownerId,
      acquired.raid.id,
      {
        sourceSha256: sourceSha,
        sizeBytes: source.length,
        contentType: 'image/png',
        purpose: 'gallery',
      },
      'finalizing-race-media',
    )
    const expiredIntent = await raidService!.createMediaIntent(
      ownerId,
      acquired.raid.id,
      {
        sourceSha256: 'd'.repeat(64),
        sizeBytes: 100,
        contentType: 'image/jpeg',
        purpose: 'gallery',
      },
      'finalizing-race-expired-media',
    )
    await pool!.query('UPDATE raid_media SET upload_expires_at = now() - interval \'1 second\' WHERE id = $1', [
      expiredIntent.intentId,
    ])
    const finish = await raidService!.finishRaid(
      ownerId,
      acquired.raid.id,
      {
        expectedVersion: acquired.raid.version,
        inventory: { routePending: 0, checkInsPending: 0, mediaPending: 0, needsAction: 0 },
        confirmPartial: false,
      },
      'finalizing-race-finish',
    )
    expect(finish.finalization.partial).toBe(false)
    const raced = await Promise.allSettled([
      raidService!.respondClaim(
        memberId,
        acquired.raid.id,
        claimId,
        'confirm',
        'finalizing-race-confirm-claim',
      ),
      raidService!.uploadMedia(
        ownerId,
        acquired.raid.id,
        intent.intentId,
        intent.uploadCapability,
        sourceSha,
        source,
      ),
      raidService!.settleFinalization(
        ownerId,
        acquired.raid.id,
        finish.raid.version,
        'finalizing-race-settle-first',
      ),
    ])
    expect(raced[0]!.status).toBe('fulfilled')
    expect(raced[1]!.status).toBe('fulfilled')
    if (raced[2]!.status === 'rejected') {
      expect(raced[2]!.reason).toMatchObject({ code: 'FINALIZATION_PENDING' })
    }
    const afterRace = await raidService!.getRaid(ownerId, acquired.raid.id)
    const settled =
      afterRace.state === 'completed'
        ? { result: await raidService!.getResult(ownerId, acquired.raid.id) }
        : await raidService!.settleFinalization(
            ownerId,
            acquired.raid.id,
            afterRace.version,
            'finalizing-race-settle-second',
          )
    expect(settled.result).toMatchObject({
      raid: { partial: true },
      team: { uniquePoints: 1, photos: 1 },
    })
    expect(
      settled.result.participants.find((participant) => participant.userId === memberId)?.metrics,
    ).toMatchObject({ uniquePoints: 1 })
    expect(
      (
        await pool!.query<{ state: string }>('SELECT state FROM raid_media WHERE id = $1', [
          expiredIntent.intentId,
        ])
      ).rows[0]!.state,
    ).toBe('expired_finalization')
  })

  it('serializes finish against the last route batch and freezes that generation', async () => {
    const { ownerId, kabanda } = await ownerAndKabanda('finish-route-race')
    const { acquired, clientInstanceId, leaseId } = await activeOwnerRaid(
      ownerId,
      kabanda.id,
      'finish-route-race',
    )
    const raced = await Promise.allSettled([
      raidService!.finishRaid(
        ownerId,
        acquired.raid.id,
        {
          expectedVersion: acquired.raid.version,
          inventory: { routePending: 0, checkInsPending: 0, mediaPending: 0, needsAction: 0 },
          confirmPartial: false,
        },
        'finish-route-race-finish',
      ),
      raidService!.submitRouteBatch(
        ownerId,
        acquired.raid.id,
        {
          schemaVersion: 1,
          leaseId,
          clientInstanceId,
          samples: [
            {
              operationId: 'finish-route-race-sample',
              sequence: 1,
              capturedAt: new Date().toISOString(),
              latitude: 56.86,
              longitude: 53.21,
              accuracyM: 8,
            },
          ],
        },
        'finish-route-race-batch',
      ),
    ])
    expect(raced[0]!.status).toBe('fulfilled')
    if (raced[1]!.status === 'rejected') {
      expect(raced[1]!.reason).toMatchObject({ code: 'NAVIGATOR_LEASE_SUPERSEDED' })
    }
    const storedSamples = Number(
      (
        await pool!.query(
          'SELECT count(*) FROM raid_route_samples WHERE raid_id = $1 AND lease_id = $2',
          [acquired.raid.id, leaseId],
        )
      ).rows[0]!.count,
    )
    const cutoff = Number(
      (
        await pool!.query(
          `SELECT max_sequence FROM raid_route_finalization_cutoffs
           WHERE raid_id = $1 AND lease_id = $2`,
          [acquired.raid.id, leaseId],
        )
      ).rows[0]!.max_sequence,
    )
    expect(cutoff).toBe(storedSamples)
  })
})
