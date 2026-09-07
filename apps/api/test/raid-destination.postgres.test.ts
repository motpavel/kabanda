import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { DatabaseRaidService } from '../src/raids.js'

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null
const suite = pool ? describe : describe.skip

suite('shared raid destination', () => {
  let nav: string, member: string, outsider: string, raid: string, point: string, foreignPoint: string
  const service = pool ? new DatabaseRaidService(pool, 'local-destination-test-secret-at-least-32-bytes') : null
  beforeEach(async () => {
    const db = pool!
    nav = randomUUID(); member = randomUUID(); outsider = randomUUID(); raid = randomUUID(); point = randomUUID(); foreignPoint = randomUUID()
    const team = randomUUID(), collection = randomUUID(), source = randomUUID(), otherRaid = randomUUID()
    // Unique fixtures: never truncate another suite's data or the local preview.
    await db.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Навигатор'),($3,$4,'Участник'),($5,$6,'Другой')", [nav, `${nav}@example.test`, member, `${member}@example.test`, outsider, `${outsider}@example.test`])
    await db.query("INSERT INTO kabandas(id,name,owner_id,create_idempotency_key) VALUES($1,'Destination test',$2,$1::uuid::text)", [team, nav])
    await db.query("INSERT INTO kabanda_memberships(kabanda_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [team, nav, member])
    await db.query("INSERT INTO point_collections(id,kabanda_id,name) VALUES($1,$2,'Test')", [collection, team])
    await db.query("INSERT INTO points(id,kabanda_id,stable_key,name,location,source,source_id,source_url,license,verification_status) VALUES($1,$2,$1::uuid::text,'Цель',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),'test',$1::uuid::text,'https://example.test','test','field_verified')", [source, team])
    await db.query("INSERT INTO raids(id,kabanda_id,organizer_user_id,navigator_user_id,title,state,started_at) VALUES($1,$2,$3,$3,'Active','active',now()),($4,$2,$3,$3,'Other','draft',NULL)", [raid, team, nav, otherRaid])
    await db.query("INSERT INTO raid_participants(raid_id,user_id,state,active_from) VALUES($1,$2,'active',now()),($1,$3,'active',now())", [raid, nav, member])
    await db.query("INSERT INTO raid_point_snapshots(id,raid_id,source_point_id,collection_id,name,location,position) VALUES($1,$2,$3,$4,'Цель',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),0),($5,$6,$3,$4,'Чужая',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),0)", [point, raid, source, collection, foreignPoint, otherRaid])
  })
  afterAll(async () => { await pool?.end() })
  const select = (actor = nav, version = 1, target = point, key = randomUUID()) => service!.setDestination(actor, raid, { expectedVersion: version, pointSnapshotId: target }, key)
  const checkin = (actor: string, extra = {}) => service!.createCheckin(actor, raid, {
    pointSnapshotId: point, evidence: { latitude: 56.86, longitude: 53.21, accuracyMeters: 8, capturedAt: new Date().toISOString() },
    presentParticipantIds: [], organizerAttestation: false, ...extra,
  }, randomUUID())

  it('publishes one destination to both players and handles retries and stale writes', async () => {
    const key = randomUUID()
    const result = await select(nav, 1, point, key)
    expect(result.raid.destination).toMatchObject({ pointSnapshotId: point, name: 'Цель', latitude: 56.86, longitude: 53.21 })
    expect(result.raid.version).toBe(2)
    expect((await service!.getRaid(member, raid)).destination).toEqual(result.raid.destination)
    expect((await select(nav, 1, point, key)).raid.version).toBe(2)
    await expect(select(nav, 1)).rejects.toMatchObject({ statusCode: 409 })
    await expect(select(nav, 2, foreignPoint, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('rejects non-navigators, outsiders, foreign points and inactive raids', async () => {
    await expect(select(member)).rejects.toMatchObject({ statusCode: 403 })
    await expect(select(outsider)).rejects.toMatchObject({ statusCode: 404 })
    await expect(select(nav, 1, foreignPoint)).rejects.toMatchObject({ statusCode: 404 })
    await pool!.query("UPDATE raids SET state='paused' WHERE id=$1", [raid])
    await expect(select()).rejects.toMatchObject({ statusCode: 409 })
  })

  it('keeps the target on failed GPS or another player check-in; clears on navigator confirmation', async () => {
    await select()
    expect((await checkin(nav, { evidence: { latitude: 57, longitude: 54, accuracyMeters: 8, capturedAt: new Date().toISOString() } })).outcome).toBe('needs_manual_verification')
    await checkin(member)
    expect((await service!.getRaid(member, raid)).destination?.pointSnapshotId).toBe(point)
    await checkin(nav)
    expect((await service!.getRaid(member, raid)).destination).toBeNull()
    // A repeated visit requires explicit intent: duplicate ordinary check-ins do not complete a newly chosen target.
    await select(nav, 3)
    await checkin(nav)
    expect((await service!.getRaid(nav, raid)).destination?.pointSnapshotId).toBe(point)
    await checkin(nav, { repeatVisit: true })
    expect((await service!.getRaid(member, raid)).destination).toBeNull()
  })

  it('also completes the destination when the navigator confirms a visit claim', async () => {
    await select()
    const result = await checkin(member, { presentParticipantIds: [nav] })
    expect((await service!.getRaid(nav, raid)).destination?.pointSnapshotId).toBe(point)
    await service!.respondClaim(nav, raid, result.claims[0]!.id, 'confirm', randomUUID())
    expect((await service!.getRaid(member, raid)).destination).toBeNull()
  })
})
