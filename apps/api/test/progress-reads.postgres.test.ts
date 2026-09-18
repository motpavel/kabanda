import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { IZHEVSK_KB_STORES } from '@kabanda/contracts'
import { DatabaseProgressReadService } from '../src/progress-reads.js'
import { readPointVisitHistory } from '../src/point-history.js'

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null
const databaseTests = pool ? describe : describe.skip

databaseTests('participation-aware history and confirmed city progress', () => {
  let client: PoolClient
  let reads: DatabaseProgressReadService
  let viewer: string, owner: string, team: string, pointId: string
  const store = IZHEVSK_KB_STORES[0]!
  beforeEach(async () => {
    client = await pool!.connect()
    await client.query('BEGIN')
    reads = new DatabaseProgressReadService(client)
    viewer = randomUUID(); owner = randomUUID(); team = randomUUID(); pointId = randomUUID()
    await client.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Участник'),($3,$4,'Вожак')", [viewer, `${viewer}@example.test`, owner, `${owner}@example.test`])
    await client.query("INSERT INTO kabandas(id,name,owner_id,create_idempotency_key) VALUES($1,'История и прогресс',$2,$1::uuid::text)", [team, owner])
    await client.query("INSERT INTO kabanda_memberships(kabanda_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'owner')", [team, viewer, owner])
    await client.query(`INSERT INTO points(id,kabanda_id,stable_key,name,location,source,source_id,source_url,license,verification_status)
      VALUES($1,$2,$3,'Магазин',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),'kb_store',$3,'https://example.test','test','source_checked')`, [pointId, team, store.id])
  })
  afterEach(async () => { await client.query('ROLLBACK'); client.release() })
  afterAll(async () => { await pool?.end() })

  async function completed(at: string, mine = false) {
    const id = randomUUID()
    await client.query(`INSERT INTO raids(id,kabanda_id,organizer_user_id,title,state,started_at,finalizing_at,finalization_deadline_at,completed_at)
      VALUES($1,$2,$3,'Результат','completed',$4::timestamptz-interval '1 hour',$4,$4,$4)`, [id, team, owner, at])
    await client.query(`INSERT INTO raid_results(raid_id,kabanda_id,schema_version,partial,started_at,completed_at,team_duration_seconds,team_distance_meters,team_unique_points,team_photos,result_json,share_png,share_sha256)
      VALUES($1,$2,1,false,$3::timestamptz-interval '1 hour',$3,0,0,0,0,'{}',decode(repeat('00',64),'hex'),repeat('0',64))`, [id, team, at])
    if (mine) await client.query(`INSERT INTO raid_result_participants(raid_id,user_id,display_name,duration_seconds,distance_meters,unique_points,photos)
      VALUES($1,$2,'Участник',0,0,0,0)`, [id, viewer])
    return id
  }

  it('finds a zero-metric participant beyond page one and pages without missing microseconds', async () => {
    const ids: string[] = []
    for (let i = 0; i < 15; i++) ids.push(await completed(`2026-09-17T12:00:00.${String(999900 - i).padStart(6, '0')}Z`, i === 14))
    const first = await reads.history(viewer, team, { filter: 'all', limit: 12 })
    expect(first.raids.map(row => row.raidId)).toEqual(ids.slice(0, 12))
    expect(first.raids.every(row => !row.participated)).toBe(true)
    const second = await reads.history(viewer, team, { filter: 'all', limit: 12, cursor: first.nextCursor! })
    expect(second.raids.map(row => row.raidId)).toEqual(ids.slice(12))
    expect(second.nextCursor).toBeNull()
    const mine = await reads.history(viewer, team, { filter: 'mine', limit: 12 })
    expect(mine.raids).toHaveLength(1)
    expect(mine.raids[0]).toMatchObject({ raidId: ids[14], participated: true, personal: { distanceMeters: 0, durationSeconds: 0, uniquePoints: 0, photos: 0 } })
    const before = await client.query('SELECT result_json FROM raid_results WHERE kabanda_id=$1 ORDER BY raid_id', [team])
    await reads.history(viewer, team, { filter: 'all', limit: 50 })
    expect((await client.query('SELECT result_json FROM raid_results WHERE kabanda_id=$1 ORDER BY raid_id', [team])).rows).toEqual(before.rows)
  })

  it('uses raid ID as the exact-time tie breaker and binds a cursor to actor, team and filter', async () => {
    const ids = await Promise.all([completed('2026-09-17T12:00:00Z', true), completed('2026-09-17T12:00:00Z', true)])
    ids.sort().reverse()
    const first = await reads.history(viewer, team, { filter: 'mine', limit: 1 })
    const second = await reads.history(viewer, team, { filter: 'mine', limit: 1, cursor: first.nextCursor! })
    expect([first.raids[0]!.raidId, second.raids[0]!.raidId]).toEqual(ids)
    for (const [actor, kabanda, filter] of [[owner, team, 'mine'], [viewer, randomUUID(), 'mine'], [viewer, team, 'all']] as const) {
      await expect(reads.history(actor, kabanda, { filter, limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_INVALID' })
    }
    await expect(reads.history(viewer, team, { filter: 'all', limit: 12, cursor: 'invalid' })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_INVALID' })
  })

  it('returns a real empty page but indistinguishable denial for unknown, removed or archived membership', async () => {
    expect(await reads.history(viewer, team, { filter: 'mine', limit: 12 })).toEqual({ raids: [], nextCursor: null })
    await expect(reads.history(randomUUID(), team, { filter: 'all', limit: 12 })).rejects.toMatchObject({ statusCode: 404 })
    await client.query('UPDATE kabanda_memberships SET removed_at=now() WHERE kabanda_id=$1 AND user_id=$2', [team, viewer])
    await expect(reads.history(viewer, team, { filter: 'all', limit: 12 })).rejects.toMatchObject({ statusCode: 404 })
    await expect(reads.points(viewer, team, { category: 'stores' })).rejects.toMatchObject({ statusCode: 404 })
    await client.query('UPDATE kabandas SET archived_at=now() WHERE id=$1', [team])
    await expect(reads.history(owner, team, { filter: 'all', limit: 12 })).rejects.toMatchObject({ statusCode: 404 })
    await expect(reads.points(owner, team, { category: 'stores' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('reads all canonical store keys, preserves separate personal/team counts and matches visit history', async () => {
    await client.query(`INSERT INTO point_visits(kabanda_id,point_id,user_id,idempotency_key,point_name_snapshot,point_location_snapshot)
      VALUES($1,$2,$3,gen_random_uuid()::text,'Магазин',ST_SetSRID(ST_MakePoint(53.21,56.86),4326)),
      ($1,$2,$4,gen_random_uuid()::text,'Магазин',ST_SetSRID(ST_MakePoint(53.21,56.86),4326))`, [team, pointId, viewer, owner])
    const page = await reads.points(viewer, team, { category: 'stores' })
    expect(page.points).toHaveLength(IZHEVSK_KB_STORES.length)
    expect(page.points.find(point => point.stableId === store.id)).toEqual({ stableId: store.id, pointId, personalCount: 1, teamCount: 2 })
    expect(page.points.find(point => point.stableId === IZHEVSK_KB_STORES[1]!.id)).toMatchObject({ pointId: null, personalCount: 0, teamCount: 0 })
    const history = await readPointVisitHistory(client, viewer, team, pointId)
    expect(history.personalCount).toBe(1)
    expect(history.visitors.reduce((sum, visitor) => sum + visitor.count, 0)).toBe(2)
    expect(Object.keys(page.points[0]!).sort()).toEqual(['personalCount', 'pointId', 'stableId', 'teamCount'])
    await expect(reads.points(owner, randomUUID(), { category: 'stores' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('does not count pending claims or give earlier team credits to a later active participant', async () => {
    const raidId = randomUUID(), snapshot = randomUUID(), attempt = randomUUID(), credit = randomUUID()
    await client.query("INSERT INTO raids(id,kabanda_id,organizer_user_id,title,state,started_at) VALUES($1,$2,$3,'Живой рейд','active',now())", [raidId, team, owner])
    await client.query("INSERT INTO raid_participants(raid_id,user_id,state,active_from) VALUES($1,$2,'active',now()),($1,$3,'invited',NULL)", [raidId, owner, viewer])
    await client.query(`INSERT INTO raid_point_snapshots(id,raid_id,source_point_id,name,location,position)
      VALUES($1,$2,$3,'Магазин',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),0)`, [snapshot, raidId, pointId])
    await client.query(`INSERT INTO raid_checkin_attempts(id,raid_id,point_snapshot_id,actor_user_id,evidence_location,evidence_captured_at,evidence_accuracy_meters,outcome)
      VALUES($1,$2,$3,$4,ST_SetSRID(ST_MakePoint(53.21,56.86),4326),now(),8,'accepted')`, [attempt, raidId, snapshot, owner])
    await client.query("INSERT INTO raid_point_credits(id,raid_id,point_snapshot_id,user_id,source,evidence_attempt_id) VALUES($1,$2,$3,$4,'gps',$5)", [credit, raidId, snapshot, owner, attempt])
    await client.query("INSERT INTO raid_point_visit_events(credit_id,evidence_attempt_id,user_id,source) VALUES($1,$2,$3,'gps')", [credit, attempt, owner])
    await client.query("INSERT INTO raid_checkin_claims(raid_id,attempt_id,user_id,status) VALUES($1,$2,$3,'pending')", [raidId, attempt, viewer])
    const summary = async (actor: string) => (await reads.points(actor, team, { category: 'stores' })).points.find(point => point.pointId === pointId)
    expect(await summary(viewer)).toMatchObject({ personalCount: 0, teamCount: 0 })
    expect(await summary(owner)).toMatchObject({ personalCount: 1, teamCount: 1 })
    await client.query("UPDATE raid_participants SET state='active', active_from=clock_timestamp() WHERE raid_id=$1 AND user_id=$2", [raidId, viewer])
    expect(await summary(viewer)).toMatchObject({ personalCount: 0, teamCount: 1 })
    await client.query("UPDATE raid_participants SET state='left', left_at=clock_timestamp() WHERE raid_id=$1 AND user_id=$2", [raidId, viewer])
    expect(await summary(viewer)).toMatchObject({ personalCount: 0, teamCount: 0 })
    expect((await client.query('SELECT count(*)::int AS count FROM raid_point_credits WHERE raid_id=$1', [raidId])).rows[0].count).toBe(1)
  })
})
