import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import sharp from 'sharp'
import { FieldRaidService, type TeamVisitInput } from '../src/field-service.js'
import { readRouteChanges, ROUTE_CHANGES_PAGE_SIZE } from '../src/field-track.js'
import { PointMaterialService } from '../src/point-materials.js'
import { DatabaseRaidService } from '../src/raids.js'

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null
const suite = pool ? describe : describe.skip
suite('field synchronization through real PostgreSQL services', () => {
  let owner: string, nav: string, rider: string, other: string, outsider: string
  let raid: string, team: string, point: string, pointB: string, lease: string
  const service = pool ? new FieldRaidService(pool, 'field-tests-only-capability-secret-at-least-32-bytes') : null
  const materials = pool ? new PointMaterialService(pool) : null
  const input = (extra: Partial<TeamVisitInput> = {}): TeamVisitInput => ({
    pointSnapshotId: point, evidence: { latitude: 56.86, longitude: 53.21, accuracyMeters: 8, capturedAt: new Date().toISOString() },
    presentParticipantIds: [rider], confirmedAttendance: true, ...extra,
  })
  beforeEach(async () => {
    owner = randomUUID(); nav = randomUUID(); rider = randomUUID(); other = randomUUID(); outsider = randomUUID()
    raid = randomUUID(); team = randomUUID(); point = randomUUID(); pointB = randomUUID(); lease = randomUUID()
    const collection = randomUUID(), source = randomUUID(), sourceB = randomUUID()
    // Unique fixture IDs; no shared truncation or production access.
    for (const [id, name] of [[owner, 'Организатор'], [nav, 'Навигатор'], [rider, 'Участник'], [other, 'Без отметки'], [outsider, 'Чужой']]) {
      await pool!.query('INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)', [id, `${id}@example.test`, name])
    }
    await pool!.query("INSERT INTO kabandas(id,name,owner_id,create_idempotency_key) VALUES($1,'Field fixture',$2,$1::uuid::text)", [team, owner])
    await pool!.query("INSERT INTO kabanda_memberships(kabanda_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member'),($1,$5,'member')", [team, owner, nav, rider, other])
    await pool!.query("INSERT INTO point_collections(id,kabanda_id,name) VALUES($1,$2,'Fixture points')", [collection, team])
    for (const id of [source, sourceB]) await pool!.query(`INSERT INTO points(id,kabanda_id,stable_key,name,location,source,source_id,source_url,license,verification_status)
      VALUES($1,$2,$1::uuid::text,'Остановка',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),'test',$1::uuid::text,'https://example.test','test','field_verified')`, [id, team])
    await pool!.query(`INSERT INTO raids(id,kabanda_id,organizer_user_id,navigator_user_id,title,state,started_at)
      VALUES($1,$2,$3,$4,'Field run','active',now()-interval '20 minutes')`, [raid, team, owner, nav])
    for (const id of [owner, nav, rider, other]) await pool!.query("INSERT INTO raid_participants(raid_id,user_id,state,active_from) VALUES($1,$2,'active',now()-interval '20 minutes')", [raid, id])
    await pool!.query(`INSERT INTO raid_point_snapshots(id,raid_id,source_point_id,collection_id,name,location,position)
      VALUES($1,$2,$3,$4,'Остановка',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),0),
      ($5,$2,$6,$4,'Вторая',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),1)`, [point, raid, source, collection, pointB, sourceB])
    await pool!.query("INSERT INTO raid_activity_windows(raid_id,opened_at,opened_version) VALUES($1,now()-interval '20 minutes',1)", [raid])
    await pool!.query('INSERT INTO raid_navigator_leases(id,raid_id,navigator_user_id,generation) VALUES($1,$2,$3,1)', [lease, raid, nav])
  })
  afterAll(async () => { await pool?.end() })
  const count = async (table: string) => Number((await pool!.query(`SELECT count(*)::int AS n FROM ${table} WHERE raid_id=$1`, [raid])).rows[0]!.n)
  const sample = async (sequence: number, accuracy = 8) => pool!.query(`INSERT INTO raid_route_samples
    (raid_id,lease_id,operation_id,sequence,captured_at,geom,accuracy_m,speed_mps,payload_hash)
    VALUES($1,$2,$2::uuid::text||':'||$3::bigint::text,$3::bigint,now()-interval '10 minutes'+$3::bigint*interval '1 second',
      ST_SetSRID(ST_MakePoint(53.21,56.86+$3::bigint*0.00001),4326)::geography,$4,1,repeat('a',64))`, [raid, lease, sequence, accuracy])

  it('lets the assigned navigator, not merely the organizer, confirm exactly one selected team visit', async () => {
    await expect(service!.createTeamVisit(owner, raid, input(), randomUUID())).rejects.toMatchObject({ code: 'NAVIGATOR_REQUIRED' })
    await expect(service!.createTeamVisit(rider, raid, input(), randomUUID())).rejects.toMatchObject({ code: 'NAVIGATOR_REQUIRED' })
    await expect(service!.createTeamVisit(outsider, raid, input(), randomUUID())).rejects.toMatchObject({ statusCode: 404 })
    const response = await service!.createTeamVisit(nav, raid, input(), randomUUID())
    expect(response.outcome).toBe('accepted')
    expect(response.credits.map(credit => credit.userId).sort()).toEqual([nav, rider].sort())
    expect(response.claims).toEqual([])
    expect(await count('raid_point_credits')).toBe(2)
    expect(await count('raid_checkin_claims')).toBe(0)
    expect(await count('raid_navigator_attestations')).toBe(1)
    const observer = await service!.getFastSnapshot(other, raid)
    expect(observer.points?.find(item => item.id === point)).toMatchObject({ visitedByTeam: true, visitedByMe: false })
    expect((await service!.getFastSnapshot(rider, raid)).points?.find(item => item.id === point)).toMatchObject({ visitedByTeam: true, visitedByMe: true })
  })

  it('replays a lost acknowledgement and rejects a different operation racing the same stop', async () => {
    const payload = input(), operation = randomUUID()
    const replies = await Promise.all([service!.createTeamVisit(nav, raid, payload, operation), service!.createTeamVisit(nav, raid, payload, operation)])
    expect(replies[0]).toEqual(replies[1])
    expect(await count('raid_checkin_attempts')).toBe(1)
    await expect(service!.createTeamVisit(nav, raid, { ...payload, presentParticipantIds: [] }, operation)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(service!.createTeamVisit(nav, raid, payload, randomUUID())).rejects.toMatchObject({ code: 'TEAM_VISIT_ALREADY_CONFIRMED' })
    await pool!.query('UPDATE raids SET navigator_user_id=$2,version=version+1 WHERE id=$1', [raid, other])
    expect(await service!.createTeamVisit(nav, raid, payload, operation)).toEqual(replies[0])
    await expect(service!.createTeamVisit(nav, raid, input({ pointSnapshotId: pointB }), randomUUID())).rejects.toMatchObject({ code: 'NAVIGATOR_REQUIRED' })
    await pool!.query('UPDATE kabanda_memberships SET removed_at=now() WHERE kabanda_id=$1 AND user_id=$2', [team, nav])
    await expect(service!.createTeamVisit(nav, raid, payload, operation)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('requires the actual last visit for repeats without inflating unique-point credits', async () => {
    const first = await service!.createTeamVisit(nav, raid, input(), randomUUID())
    await pool!.query("UPDATE raid_point_visit_events SET created_at=clock_timestamp()-interval '5 minutes' WHERE evidence_attempt_id=$1", [first.attemptId])
    const second = await service!.createTeamVisit(nav, raid, input({ repeatVisit: true, previousAttemptId: first.attemptId }), randomUUID())
    expect(second.attemptId).not.toBe(first.attemptId)
    expect(await count('raid_point_credits')).toBe(2)
    const events = await pool!.query('SELECT count(*)::int AS n FROM raid_point_visit_events WHERE evidence_attempt_id=ANY($1::uuid[])', [[first.attemptId, second.attemptId]])
    expect(events.rows[0]!.n).toBe(4)
    await expect(service!.createTeamVisit(nav, raid, input({ repeatVisit: true, previousAttemptId: first.attemptId }), randomUUID())).rejects.toMatchObject({ code: 'TEAM_VISIT_ALREADY_CONFIRMED' })
  })

  it('does not grant credits for an invalid GPS fix or a departed selected rider', async () => {
    const payload = input({ evidence: { latitude: 56.9, longitude: 53.21, accuracyMeters: 8, capturedAt: new Date().toISOString() } })
    const response = await service!.createTeamVisit(nav, raid, payload, randomUUID())
    expect(response).toMatchObject({ outcome: 'needs_manual_verification', reason: 'too_far', credits: [], claims: [] })
    await pool!.query("UPDATE raid_participants SET state='left',left_at=now() WHERE raid_id=$1 AND user_id=$2", [raid, rider])
    await expect(service!.createTeamVisit(nav, raid, input(), randomUUID())).rejects.toMatchObject({ code: 'ATTENDANCE_CHANGED' })
    expect(await count('raid_point_credits')).toBe(0)
  })

  it('refuses new legacy self-checkins and confirmations but replays accepted historical receipts', async () => {
    const oldService = new DatabaseRaidService(pool!, 'field-tests-only-capability-secret-at-least-32-bytes')
    const payload = { ...input(), presentParticipantIds: [owner], organizerAttestation: false }
    const operation = randomUUID()
    const legacy = await oldService.createCheckin(rider, raid, payload, operation)
    expect(await service!.createCheckin(rider, raid, payload, operation)).toEqual(legacy)
    await expect(service!.createCheckin(rider, raid, payload, randomUUID())).rejects.toMatchObject({ code: 'NAVIGATOR_REQUIRED' })
    await expect(service!.createCheckin(owner, raid, { ...payload, organizerAttestation: true }, randomUUID())).rejects.toMatchObject({ code: 'NAVIGATOR_REQUIRED' })
    await expect(service!.respondClaim(owner, raid, legacy.claims[0]!.id, 'confirm', randomUUID())).rejects.toMatchObject({ code: 'NAVIGATOR_REQUIRED' })
    const confirmationOperation = randomUUID()
    const confirmed = await oldService.respondClaim(owner, raid, legacy.claims[0]!.id, 'confirm', confirmationOperation)
    expect(await service!.respondClaim(owner, raid, legacy.claims[0]!.id, 'confirm', confirmationOperation)).toEqual(confirmed)
    await expect(service!.createFallback(rider, raid, {
      attemptId: legacy.attemptId, mediaId: randomUUID(), verifierUserId: owner, presentParticipantIds: [], reason: 'GPS',
    }, randomUUID())).rejects.toMatchObject({ code: 'NAVIGATOR_REQUIRED' })
    await expect(service!.respondFallback(owner, raid, randomUUID(), 'confirm', randomUUID())).rejects.toMatchObject({ code: 'NAVIGATOR_REQUIRED' })
  })

  it('blocks repeats for five server-clock minutes without blocking receipt replay or another point', async () => {
    const payload = input(), operation = randomUUID()
    const first = await service!.createTeamVisit(nav, raid, payload, operation)
    const repeat = input({ repeatVisit: true, previousAttemptId: first.attemptId })
    await expect(service!.createTeamVisit(nav, raid, repeat, randomUUID())).rejects.toMatchObject({
      code: 'TEAM_VISIT_COOLDOWN', statusCode: 409,
      details: { retryAt: expect.any(String), retryAfterSeconds: expect.any(Number) },
    })
    expect(await service!.createTeamVisit(nav, raid, payload, operation)).toEqual(first)
    expect(await count('raid_checkin_attempts')).toBe(1)
    await expect(service!.createCheckin(nav, raid, { ...repeat, organizerAttestation: false }, randomUUID())).rejects.toMatchObject({ code: 'TEAM_VISIT_COOLDOWN' })
    expect((await service!.createTeamVisit(nav, raid, input({ pointSnapshotId: pointB }), randomUUID())).outcome).toBe('accepted')
    await pool!.query("UPDATE raid_point_visit_events SET created_at=clock_timestamp()-interval '4 minutes' WHERE evidence_attempt_id=$1", [first.attemptId])
    await expect(service!.createTeamVisit(nav, raid, repeat, randomUUID())).rejects.toMatchObject({ code: 'TEAM_VISIT_COOLDOWN' })
    await pool!.query('UPDATE raids SET navigator_user_id=$2,version=version+1 WHERE id=$1', [raid, other])
    await expect(service!.createTeamVisit(other, raid, repeat, randomUUID())).rejects.toMatchObject({ code: 'TEAM_VISIT_COOLDOWN' })
    await pool!.query("UPDATE raid_point_visit_events SET created_at=clock_timestamp()-interval '5 minutes' WHERE evidence_attempt_id=$1", [first.attemptId])
    expect((await service!.createTeamVisit(other, raid, input({ repeatVisit: true, previousAttemptId: first.attemptId }), randomUUID())).outcome).toBe('accepted')
  })

  it('allows only one concurrent repeat and publishes personal visit identities and server timestamps', async () => {
    const first = await service!.createTeamVisit(nav, raid, input(), randomUUID())
    const firstSnapshot = await service!.getFastSnapshot(rider, raid)
    const initial = firstSnapshot.points!.find(item => item.id === point)!
    expect(initial).toMatchObject({ lastAttemptId: first.attemptId, myLastVisitAttemptId: first.attemptId,
      lastVisitParticipantIds: [nav, rider].sort() })
    expect(Date.parse(initial.repeatAvailableAt!) - Date.parse(initial.lastVisitedAt!)).toBe(300_000)
    expect(firstSnapshot.points!.find(item => item.id === pointB)).toMatchObject({
      lastVisitedAt: null, repeatAvailableAt: null, lastVisitParticipantIds: [], myLastVisitAttemptId: null,
    })
    await pool!.query("UPDATE raid_point_visit_events SET created_at=clock_timestamp()-interval '5 minutes' WHERE evidence_attempt_id=$1", [first.attemptId])
    const repeat = input({ repeatVisit: true, previousAttemptId: first.attemptId, presentParticipantIds: [other] })
    const results = await Promise.allSettled([
      service!.createTeamVisit(nav, raid, repeat, randomUUID()), service!.createTeamVisit(nav, raid, repeat, randomUUID()),
    ])
    const success = results.filter(result => result.status === 'fulfilled')
    expect(success).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const second = (success[0] as PromiseFulfilledResult<Awaited<ReturnType<FieldRaidService['createTeamVisit']>>>).value
    const riderSnapshot = await service!.getFastSnapshot(rider, raid, firstSnapshot.pointsRevision)
    expect(riderSnapshot.points!.find(item => item.id === point)).toMatchObject({
      lastAttemptId: second.attemptId, myLastVisitAttemptId: first.attemptId, lastVisitParticipantIds: [nav, other].sort(),
    })
    expect((await service!.getFastSnapshot(other, raid)).points!.find(item => item.id === point)).toMatchObject({ myLastVisitAttemptId: second.attemptId })
    expect(await count('raid_checkin_attempts')).toBe(2)
  })

  it('does not restart cooldown on a rejected GPS attempt or use its client timestamp', async () => {
    const first = await service!.createTeamVisit(nav, raid, input(), randomUUID())
    await pool!.query("UPDATE raid_point_visit_events SET created_at=clock_timestamp()-interval '5 minutes' WHERE evidence_attempt_id=$1", [first.attemptId])
    const repeat = input({ repeatVisit: true, previousAttemptId: first.attemptId })
    const rejected = await service!.createTeamVisit(nav, raid, { ...repeat,
      evidence: { ...repeat.evidence, capturedAt: new Date(Date.now() - 600_000).toISOString() },
    }, randomUUID())
    expect(rejected).toMatchObject({ outcome: 'needs_manual_verification', reason: 'location_expired' })
    expect((await service!.getFastSnapshot(nav, raid)).points!.find(item => item.id === point)?.lastAttemptId).toBe(first.attemptId)
    expect((await service!.createTeamVisit(nav, raid, input({ repeatVisit: true, previousAttemptId: first.attemptId }), randomUUID())).outcome).toBe('accepted')
  })

  it('clears the reached shared destination only after a confirmed visit, never on a failed attempt or replay', async () => {
    await service!.setDestination(nav, raid, { expectedVersion: 1, pointSnapshotId: point }, randomUUID())
    const before = await service!.getRaid(nav, raid)
    await service!.createTeamVisit(nav, raid, input({ evidence: { ...input().evidence, accuracyMeters: 100 } }), randomUUID())
    expect((await service!.getRaid(rider, raid)).destination?.pointSnapshotId).toBe(point)
    const payload = input(), operation = randomUUID()
    await service!.createTeamVisit(nav, raid, payload, operation)
    const after = await service!.getRaid(rider, raid)
    expect(after.destination).toBeNull()
    expect(after.version).toBe(before.version + 1)
    await service!.setDestination(nav, raid, { expectedVersion: after.version, pointSnapshotId: pointB }, randomUUID())
    await service!.createTeamVisit(nav, raid, payload, operation)
    expect((await service!.getRaid(rider, raid)).destination?.pointSnapshotId).toBe(pointB)
  })

  it('changes point revisions only for point changes and never calls the full route reader', async () => {
    const fullRoute = vi.spyOn(service!, 'getRouteTrack')
    try {
      const before = await service!.getFastSnapshot(rider, raid)
      await service!.reportPresence(rider, raid, { latitude: 56.86, longitude: 53.21, accuracyMeters: 8, capturedAt: new Date().toISOString() })
      const presence = await service!.getFastSnapshot(rider, raid, before.pointsRevision)
      expect(presence).not.toHaveProperty('track')
      expect(presence).not.toHaveProperty('points')
      expect(presence.pointsRevision).toBe(before.pointsRevision)
      expect(BigInt(presence.revision)).toBeGreaterThan(BigInt(before.revision))
      expect(presence.positions.some(position => position.userId === rider)).toBe(true)
      await service!.createTeamVisit(nav, raid, input(), randomUUID())
      const after = await service!.getFastSnapshot(rider, raid, before.pointsRevision)
      expect(BigInt(after.pointsRevision)).toBeGreaterThan(BigInt(before.pointsRevision))
      expect(after.points?.find(item => item.id === point)?.visitedByMe).toBe(true)
      expect(fullRoute).not.toHaveBeenCalled()
      expect(Buffer.byteLength(JSON.stringify(presence))).toBeLessThan(8192)
    } finally { fullRoute.mockRestore() }
  })

  it('delivers bounded incremental pages and repairs a successor when a late GPS sequence arrives', async () => {
    await sample(1); await sample(3)
    const first = await readRouteChanges(pool!, rider, raid, '0')
    expect(first.reset).toBe(true)
    expect(first.records.find(row => row.sequence === '3')?.continuesPrevious).toBe(false)
    await sample(2)
    const next = await readRouteChanges(pool!, rider, raid, first.cursor, first.epoch)
    expect(next.records.map(row => row.sequence)).toEqual(['2', '3'])
    expect(next.records.find(row => row.sequence === '3')?.continuesPrevious).toBe(true)
    const empty = await readRouteChanges(pool!, rider, raid, next.cursor, next.epoch)
    expect(empty.records).toEqual([])
    for (let sequence = 4; sequence <= 184; sequence++) await sample(sequence)
    const page = await readRouteChanges(pool!, rider, raid, next.cursor, next.epoch)
    expect(page.hasMore).toBe(true)
    expect(page.records.length).toBeLessThanOrEqual(ROUTE_CHANGES_PAGE_SIZE * 2)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024)
    expect(JSON.stringify(page)).not.toContain('payload_hash')
    await expect(readRouteChanges(pool!, outsider, raid, '0')).rejects.toMatchObject({ statusCode: 404 })
    await pool!.query("UPDATE raids SET state='paused' WHERE id=$1", [raid])
    expect((await readRouteChanges(pool!, rider, raid, page.cursor, page.epoch)).reset).toBe(true)
  })

  it('allows post-finish point materials but leaves the immutable result and share image byte-for-byte unchanged', async () => {
    const payload = input(), key = randomUUID()
    const visit = await service!.createTeamVisit(nav, raid, payload, key)
    const finished = await service!.finishRaid(owner, raid, { expectedVersion: 1,
      inventory: { routePending: 0, checkInsPending: 0, mediaPending: 0, needsAction: 0 }, confirmPartial: false }, randomUUID())
    await service!.settleFinalization(owner, raid, finished.raid.version, randomUUID())
    const before = (await pool!.query('SELECT result_json,share_sha256 FROM raid_results WHERE raid_id=$1', [raid])).rows[0]
    const body = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#777777' } }).png().toBuffer()
    const sha = createHash('sha256').update(body).digest('hex')
    const operation = randomUUID()
    const photo = await materials!.create(rider, raid, point, operation, { kind: 'photo', body: 'После финиша', sourceSha256: sha, contentType: 'image/png', sizeBytes: body.length })
    const uploaded = await materials!.upload(rider, raid, point, photo.material.id, body, sha)
    expect(uploaded.material.ready).toBe(true)
    expect(await materials!.create(rider, raid, point, operation, { kind: 'photo', body: 'После финиша', sourceSha256: sha, contentType: 'image/png', sizeBytes: body.length })).toMatchObject({ material: { id: photo.material.id, ready: true } })
    await materials!.create(rider, raid, point, randomUUID(), { kind: 'comment', body: 'Комментарий не является посещением.' })
    expect((await materials!.list(owner, raid, point)).materials).toHaveLength(2)
    expect(await service!.createTeamVisit(nav, raid, payload, key)).toEqual(visit)
    await expect(service!.createTeamVisit(nav, raid, input({ pointSnapshotId: pointB }), randomUUID())).rejects.toMatchObject({ code: 'NAVIGATOR_REQUIRED' })
    expect((await pool!.query('SELECT result_json,share_sha256 FROM raid_results WHERE raid_id=$1', [raid])).rows[0]).toEqual(before)
    await expect(materials!.read(outsider, raid, point, photo.material.id)).rejects.toMatchObject({ statusCode: 404 })
  }, 20_000)
})
