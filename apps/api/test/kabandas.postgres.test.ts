import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { DatabaseKabandaService, KabandaError, type ManifestPoint } from '../src/kabandas.js'

const databaseUrl = process.env.DATABASE_URL
const describePostgres = databaseUrl ? describe : describe.skip
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null
const service = pool ? new DatabaseKabandaService(pool) : null

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
})
