import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { IZHEVSK_KB_STORES } from '@kabanda/contracts'
import { readHistoryPage, readPointProgress } from '../src/exploration-reads.js'

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null
const databaseTests = pool ? describe : describe.skip

databaseTests('history pages and cumulative map progress', () => {
  let client: PoolClient
  let viewer: string, visitor: string, late: string, team: string
  beforeEach(async () => {
    client = await pool!.connect()
    await client.query('BEGIN')
    viewer = randomUUID(); visitor = randomUUID(); late = randomUUID(); team = randomUUID()
    for (const [id, name] of [[viewer, 'Вожак'], [visitor, 'Участник'], [late, 'Поздний участник']]) {
      await client.query('INSERT INTO users (id,email,display_name) VALUES ($1,$2,$3)', [id, `${id}@example.test`, name])
    }
    await client.query("INSERT INTO kabandas(id,name,owner_id,create_idempotency_key) VALUES ($1,'История',$2,$1::uuid::text)", [team, viewer])
    await client.query("INSERT INTO kabanda_memberships(kabanda_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')", [team, viewer, visitor, late])
  })
  afterEach(async () => { await client.query('ROLLBACK'); client.release() })
  afterAll(async () => { await pool?.end() })

  async function completed(id: string, timestamp: string, mine = false) {
    await client.query(`INSERT INTO raids(id,kabanda_id,organizer_user_id,title,state,started_at,finalizing_at,finalization_deadline_at,completed_at)
      VALUES($1,$2,$3,$1::uuid::text,'completed',$4::timestamptz-interval '1 hour',$4,$4,$4)`, [id, team, viewer, timestamp])
    await client.query(`INSERT INTO raid_results(raid_id,kabanda_id,schema_version,partial,started_at,completed_at,team_duration_seconds,team_distance_meters,team_unique_points,team_photos,result_json,share_png,share_sha256)
      VALUES($1,$2,1,false,$3::timestamptz-interval '1 hour',$3,0,0,0,0,'{}',$4,$5)`, [id, team, timestamp, Buffer.alloc(64), 'a'.repeat(64)])
    if (mine) await client.query(`INSERT INTO raid_result_participants(raid_id,user_id,display_name,duration_seconds,distance_meters,unique_points,photos)
      VALUES($1,$2,'Вожак',0,0,0,0)`, [id, viewer])
  }
  async function store(index = 0) {
    const item = IZHEVSK_KB_STORES[index]!
    const id = randomUUID()
    await client.query(`INSERT INTO points(id,kabanda_id,stable_key,name,location,source,source_id,source_url,license,verification_status)
      VALUES($1,$2,$3,'Магазин',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),'kb_store',$3,'https://example.test','test','source_checked')`, [id, team, item.id])
    return { id, stableId: item.id }
  }
  const progress = (who = viewer) => readPointProgress(client, who, team, { category: 'stores' })

  it('pages all results with ties and microseconds, and finds an old zero-metric participant', async () => {
    const ids = Array.from({ length: 26 }, (_, i) => `44444444-4444-4444-8444-${String(i + 1).padStart(12, '0')}`)
    // All same millisecond. A JS-Date-derived cursor would skip the remaining rows.
    for (const [i, id] of ids.entries()) await completed(id, '2026-09-18T12:00:00.123456Z', i === 0)
    let cursor: string | undefined
    const seen: string[] = []
    do {
      const page = await readHistoryPage(client, viewer, team, { scope: 'all', limit: 5, cursor })
      seen.push(...page.raids.map(row => row.raidId))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(seen).toEqual([...ids].reverse())
    expect(new Set(seen).size).toBe(26)
    const mine = await readHistoryPage(client, viewer, team, { scope: 'mine', limit: 12 })
    expect(mine.raids.map(row => row.raidId)).toEqual([ids[0]])
    expect(mine.raids[0]).toMatchObject({ participated: true, personal: { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0 } })
    // An invitation or decline is not a frozen participation result.
    await client.query("INSERT INTO raid_participants(raid_id,user_id,state) VALUES($1,$2,'declined')", [ids[1], visitor])
    expect((await readHistoryPage(client, visitor, team, { scope: 'mine', limit: 12 })).raids).toEqual([])
  })

  it('keeps cursor context bound and rechecks permission for every page', async () => {
    await completed(randomUUID(), '2026-09-17T12:00:00Z')
    await completed(randomUUID(), '2026-09-18T12:00:00Z')
    const first = await readHistoryPage(client, viewer, team, { scope: 'all', limit: 1 })
    expect(first.nextCursor).not.toBeNull()
    for (const [who, crew, scope] of [[visitor, team, 'all'], [viewer, randomUUID(), 'all'], [viewer, team, 'mine']] as const) {
      await expect(readHistoryPage(client, who, crew, { scope, limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_INVALID', statusCode: 400 })
    }
    await client.query('UPDATE kabanda_memberships SET removed_at=now() WHERE kabanda_id=$1 AND user_id=$2', [team, viewer])
    await expect(readHistoryPage(client, viewer, team, { scope: 'all', limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('distinguishes a permitted empty page from a missing or archived team', async () => {
    expect(await readHistoryPage(client, viewer, team, { scope: 'all', limit: 12 })).toMatchObject({ schemaVersion: 2, raids: [], nextCursor: null })
    await expect(readHistoryPage(client, randomUUID(), team, { scope: 'all', limit: 12 })).rejects.toMatchObject({ statusCode: 404 })
    await client.query('UPDATE kabandas SET archived_at=now() WHERE id=$1', [team])
    await expect(readHistoryPage(client, viewer, team, { scope: 'all', limit: 12 })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('returns explicit zero stores before the first import, then maps frozen credits by stable key', async () => {
    const empty = await progress()
    expect(empty.points).toHaveLength(IZHEVSK_KB_STORES.length)
    expect(empty.points.every(row => row.pointId === null && row.personalCount === 0 && row.teamCount === 0)).toBe(true)
    const point = await store()
    const raid = randomUUID()
    await completed(raid, '2026-09-18T12:00:00Z', true)
    await client.query('INSERT INTO raid_result_points(raid_id,user_id,source_point_id) VALUES($1,$2,$3)', [raid, visitor, point.id])
    expect((await progress()).points.find(row => row.stableId === point.stableId)).toEqual({ pointId: point.id, stableId: point.stableId, personalCount: 0, teamCount: 1 })
    await client.query('INSERT INTO raid_result_points(raid_id,user_id,source_point_id) VALUES($1,$2,$3)', [raid, viewer, point.id])
    expect((await progress()).points.find(row => row.stableId === point.stableId)).toMatchObject({ personalCount: 1, teamCount: 2 })
    expect((await progress(late)).points.find(row => row.stableId === point.stableId)).toMatchObject({ personalCount: 0, teamCount: 2 })
  })

  it('never awards a pending claim or earlier team credit to a late participant', async () => {
    const point = await store()
    const raid = randomUUID(), snapshot = randomUUID(), attempt = randomUUID(), credit = randomUUID()
    await client.query("INSERT INTO raids(id,kabanda_id,organizer_user_id,title,state,started_at) VALUES($1,$2,$3,'Рейд','active',now()-interval '1 hour')", [raid, team, viewer])
    await client.query(`INSERT INTO raid_point_snapshots(id,raid_id,source_point_id,name,location,position)
      VALUES($1,$2,$3,'Точка',ST_SetSRID(ST_MakePoint(53.21,56.86),4326)::geography,0)`, [snapshot, raid, point.id])
    await client.query(`INSERT INTO raid_checkin_attempts(id,raid_id,point_snapshot_id,actor_user_id,evidence_location,evidence_captured_at,evidence_accuracy_meters,outcome)
      VALUES($1,$2,$3,$4,ST_SetSRID(ST_MakePoint(53.21,56.86),4326)::geography,now()-interval '10 minutes',8,'accepted')`, [attempt, raid, snapshot, viewer])
    await client.query(`INSERT INTO raid_checkin_claims(raid_id,attempt_id,user_id,status) VALUES($1,$2,$3,'pending')`, [raid, attempt, late])
    expect((await progress()).points.find(row => row.stableId === point.stableId)).toMatchObject({ personalCount: 0, teamCount: 0 })
    await client.query(`INSERT INTO raid_point_credits(id,raid_id,point_snapshot_id,user_id,source,evidence_attempt_id)
      VALUES($1,$2,$3,$4,'gps',$5)`, [credit, raid, snapshot, visitor, attempt])
    await client.query(`INSERT INTO raid_point_visit_events(credit_id,evidence_attempt_id,user_id,source) VALUES($1,$2,$3,'gps')`, [credit, attempt, visitor])
    expect((await progress()).points.find(row => row.stableId === point.stableId)).toMatchObject({ personalCount: 0, teamCount: 1 })
    // Same-team membership alone does not disclose an active raid's visits.
    expect((await progress(late)).points.find(row => row.stableId === point.stableId)).toMatchObject({ personalCount: 0, teamCount: 0 })
    await client.query("INSERT INTO raid_participants(raid_id,user_id,state,active_from) VALUES($1,$2,'active',now())", [raid, late])
    expect((await progress(late)).points.find(row => row.stableId === point.stableId)).toMatchObject({ personalCount: 0, teamCount: 1 })
    await client.query("UPDATE raids SET state='cancelled' WHERE id=$1", [raid])
    expect((await progress()).points.find(row => row.stableId === point.stableId)).toMatchObject({ personalCount: 0, teamCount: 0 })
  })

  it('does not use another team or collection to authorize map progress', async () => {
    await expect(readPointProgress(client, viewer, randomUUID(), { category: 'stores' })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' })
    await expect(readPointProgress(client, viewer, team, { category: 'attractions', collection: randomUUID() })).rejects.toMatchObject({ statusCode: 404, code: 'POINT_COLLECTION_UNAVAILABLE' })
    await client.query('UPDATE kabanda_memberships SET removed_at=now() WHERE kabanda_id=$1 AND user_id=$2', [team, viewer])
    await expect(progress()).rejects.toMatchObject({ statusCode: 404 })
  })
})
