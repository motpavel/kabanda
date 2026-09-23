import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import sharp from 'sharp'
import { FieldRaidService } from '../src/field-service.js'
import { PointMaterialService } from '../src/point-materials.js'
import { processMedia } from '../src/raids.js'

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null
const suite = pool ? describe : describe.skip
suite('personal attendance authorizes point contributions, not team membership', () => {
  let owner: string, nav: string, rider: string, other: string, raid: string, team: string, point: string, pointB: string
  const visits = pool ? new FieldRaidService(pool, 'material-access-test-secret-with-at-least-32-bytes') : null
  const materials = pool ? new PointMaterialService(pool) : null
  beforeEach(async () => {
    owner = randomUUID(); nav = randomUUID(); rider = randomUUID(); other = randomUUID()
    raid = randomUUID(); team = randomUUID(); point = randomUUID(); pointB = randomUUID()
    const collection = randomUUID(), source = randomUUID(), sourceB = randomUUID()
    for (const [id, name] of [[owner, 'Владелец'], [nav, 'Навигатор'], [rider, 'Посетитель'], [other, 'Без посещения']]) {
      await pool!.query('INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)', [id, `${id}@example.test`, name])
    }
    await pool!.query("INSERT INTO kabandas(id,name,owner_id,create_idempotency_key) VALUES($1,'Material access',$2,$1::uuid::text)", [team, owner])
    await pool!.query("INSERT INTO kabanda_memberships(kabanda_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member'),($1,$5,'member')", [team, owner, nav, rider, other])
    await pool!.query("INSERT INTO point_collections(id,kabanda_id,name) VALUES($1,$2,'Access fixture')", [collection, team])
    for (const id of [source, sourceB]) await pool!.query(`INSERT INTO points(id,kabanda_id,stable_key,name,location,source,source_id,source_url,license,verification_status)
      VALUES($1,$2,$1::uuid::text,'Точка',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),'test',$1::uuid::text,'https://example.test','test','field_verified')`, [id, team])
    await pool!.query(`INSERT INTO raids(id,kabanda_id,organizer_user_id,navigator_user_id,title,state,started_at)
      VALUES($1,$2,$3,$4,'Material access','active',now()-interval '20 minutes')`, [raid, team, owner, nav])
    for (const id of [owner, nav, rider, other]) await pool!.query("INSERT INTO raid_participants(raid_id,user_id,state,active_from) VALUES($1,$2,'active',now()-interval '20 minutes')", [raid, id])
    await pool!.query(`INSERT INTO raid_point_snapshots(id,raid_id,source_point_id,collection_id,name,location,position)
      VALUES($1,$2,$3,$4,'Точка',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),0),
      ($5,$2,$6,$4,'Та же координата, другая точка',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),1)`, [point, raid, source, collection, pointB, sourceB])
    await pool!.query("INSERT INTO raid_activity_windows(raid_id,opened_at,opened_version) VALUES($1,now()-interval '20 minutes',1)", [raid])
    await pool!.query('INSERT INTO raid_navigator_leases(raid_id,navigator_user_id,generation) VALUES($1,$2,1)', [raid, nav])
  })
  afterAll(async () => { await pool?.end() })
  const visit = () => visits!.createTeamVisit(nav, raid, { pointSnapshotId: point,
    evidence: { latitude: 56.86, longitude: 53.21, accuracyMeters: 8, capturedAt: new Date().toISOString() },
    presentParticipantIds: [rider], confirmedAttendance: true }, randomUUID())
  const photograph = async () => {
    const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#777' } }).png().toBuffer()
    const sha = createHash('sha256').update(bytes).digest('hex')
    return { bytes, sha, input: { kind: 'photo' as const, body: 'Наше фото', contentType: 'image/png' as const, sourceSha256: sha, sizeBytes: bytes.length } }
  }
  const rowCount = async () => (await pool!.query('SELECT count(*)::int AS n FROM raid_point_materials WHERE raid_id=$1', [raid])).rows[0]!.n

  it('refuses both kinds for the owner, navigator and participants before a personal receipt', async () => {
    const { input } = await photograph()
    for (const id of [owner, nav, rider, other]) {
      expect(await materials!.list(id, raid, point)).toMatchObject({ canWrite: false, materials: [] })
      await expect(materials!.create(id, raid, point, randomUUID(), { kind: 'comment', body: 'Не был' })).rejects.toMatchObject({ code: 'POINT_VISIT_REQUIRED', statusCode: 403 })
      await expect(materials!.create(id, raid, point, randomUUID(), input)).rejects.toMatchObject({ code: 'POINT_VISIT_REQUIRED' })
    }
    expect(await rowCount()).toBe(0)
  })
  it('allows included riders, leaves excluded owners read-only and scopes permission to the exact stop', async () => {
    await visit()
    expect((await materials!.list(rider, raid, point)).canWrite).toBe(true)
    expect((await materials!.list(nav, raid, point)).canWrite).toBe(true)
    expect((await materials!.list(owner, raid, point)).canWrite).toBe(false)
    await materials!.create(rider, raid, point, randomUUID(), { kind: 'comment', body: 'Был на месте' })
    expect((await materials!.list(other, raid, point)).materials[0]?.body).toBe('Был на месте')
    await expect(materials!.create(owner, raid, point, randomUUID(), { kind: 'comment', body: 'Владелец' })).rejects.toMatchObject({ code: 'POINT_VISIT_REQUIRED' })
    await expect(materials!.create(rider, raid, pointB, randomUUID(), { kind: 'comment', body: 'Другая точка' })).rejects.toMatchObject({ code: 'POINT_VISIT_REQUIRED' })
    const { input, bytes, sha } = await photograph()
    const created = await materials!.create(rider, raid, point, randomUUID(), input)
    expect((await materials!.upload(rider, raid, point, created.material.id, bytes, sha)).material.ready).toBe(true)
    expect((await materials!.read(other, raid, point, created.material.id)).length).toBeGreaterThan(0)
  })
  it('preserves post-finish contributions and immutable results for confirmed participants only', async () => {
    await visit()
    const finished = await visits!.finishRaid(owner, raid, { expectedVersion: 1,
      inventory: { routePending: 0, checkInsPending: 0, mediaPending: 0, needsAction: 0 }, confirmPartial: false }, randomUUID())
    await visits!.settleFinalization(owner, raid, finished.raid.version, randomUUID())
    const before = (await pool!.query('SELECT result_json,share_sha256 FROM raid_results WHERE raid_id=$1', [raid])).rows[0]
    const key = randomUUID(), input = { kind: 'comment' as const, body: 'После финиша' }
    const result = await materials!.create(rider, raid, point, key, input)
    expect(await materials!.create(rider, raid, point, key, input)).toEqual(result)
    await expect(materials!.create(other, raid, point, randomUUID(), input)).rejects.toMatchObject({ code: 'POINT_VISIT_REQUIRED' })
    expect((await pool!.query('SELECT result_json,share_sha256 FROM raid_results WHERE raid_id=$1', [raid])).rows[0]).toEqual(before)
  })
  it('does not grandfather an unfinished legacy photo intent or delete its declared content', async () => {
    const { input, bytes, sha } = await photograph(), key = randomUUID()
    const row = (await pool!.query(`INSERT INTO raid_point_materials(raid_id,point_snapshot_id,author_user_id,operation_id,kind,body,source_sha256,declared_type,declared_size,ready)
      VALUES($1,$2,$3,$4,'photo',$5,$6,$7,$8,false) RETURNING id`, [raid, point, other, key, input.body, sha, input.contentType, bytes.length])).rows[0]!
    const processor = vi.fn(async () => processMedia(bytes, input.contentType))
    const restricted = new PointMaterialService(pool!, processor)
    await expect(restricted.upload(other, raid, point, row.id, bytes, sha)).rejects.toMatchObject({ code: 'POINT_VISIT_REQUIRED' })
    await expect(restricted.create(other, raid, point, key, input)).rejects.toMatchObject({ code: 'POINT_VISIT_REQUIRED' })
    expect(processor).not.toHaveBeenCalled()
    expect((await pool!.query('SELECT ready,content_bytes,source_sha256 FROM raid_point_materials WHERE id=$1', [row.id])).rows[0]).toEqual({ ready: false, content_bytes: null, source_sha256: sha })
  })
  it('can replay an old committed comment without authorizing any new contribution', async () => {
    const key = randomUUID(), body = 'Старый принятый комментарий'
    const row = (await pool!.query(`INSERT INTO raid_point_materials(raid_id,point_snapshot_id,author_user_id,operation_id,kind,body,ready)
      VALUES($1,$2,$3,$4,'comment',$5,true) RETURNING id`, [raid, point, other, key, body])).rows[0]!
    expect((await materials!.create(other, raid, point, key, { kind: 'comment', body })).material.id).toBe(row.id)
    await expect(materials!.create(other, raid, point, key, { kind: 'comment', body: 'Подмена' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(materials!.create(other, raid, point, randomUUID(), { kind: 'comment', body })).rejects.toMatchObject({ code: 'POINT_VISIT_REQUIRED' })
    expect(await rowCount()).toBe(1)
  })
  it('rechecks authorization after image decoding and leaves the existing intent intact on revocation', async () => {
    await visit()
    const { input, bytes, sha } = await photograph()
    const created = await materials!.create(rider, raid, point, randomUUID(), input)
    const restricted = new PointMaterialService(pool!, async (buffer, type) => {
      const processed = await processMedia(buffer, type)
      await pool!.query('UPDATE kabanda_memberships SET removed_at=now() WHERE kabanda_id=$1 AND user_id=$2', [team, rider])
      return processed
    })
    await expect(restricted.upload(rider, raid, point, created.material.id, bytes, sha)).rejects.toMatchObject({ statusCode: 404 })
    expect((await pool!.query('SELECT ready,content_bytes FROM raid_point_materials WHERE id=$1', [created.material.id])).rows[0]).toEqual({ ready: false, content_bytes: null })
  })
})
