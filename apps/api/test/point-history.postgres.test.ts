import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { readPointVisitHistory } from '../src/point-history.js'

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null
const databaseTests = pool ? describe : describe.skip

databaseTests('point history visitor totals and pages', () => {
  let client: PoolClient
  let viewer: string
  let visitor: string
  let team: string
  let point: string
  beforeEach(async () => {
    client = await pool!.connect()
    await client.query('BEGIN')
    viewer = randomUUID(); visitor = randomUUID(); team = randomUUID(); point = randomUUID()
    await client.query("INSERT INTO users (id,email,display_name) VALUES ($1,$2,'Павел'),($3,$4,'Аня')", [viewer, `${viewer}@example.test`, visitor, `${visitor}@example.test`])
    await client.query("INSERT INTO kabandas(id,name,owner_id,create_idempotency_key) VALUES ($1,'История',$2,$1::uuid::text)", [team, viewer])
    await client.query("INSERT INTO kabanda_memberships(kabanda_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [team, viewer, visitor])
    await client.query("INSERT INTO points(id,kabanda_id,stable_key,name,location,source,source_id,source_url,license,verification_status) VALUES($1,$2,$1::uuid::text,'Точка',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),'test',$1::uuid::text,'https://example.test','test','field_verified')", [point, team])
    // Put this visitor's records beyond page one in the combined history.
    for (const [userId, count, age] of [[viewer, 21, 0], [visitor, 25, 60]] as const) {
      await client.query(`INSERT INTO point_visits(kabanda_id,point_id,user_id,idempotency_key,point_name_snapshot,point_location_snapshot,visited_at)
        SELECT $1,$2,$3,gen_random_uuid()::text,'Точка',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),now()-(n+$5)*interval '1 day' FROM generate_series(1,$4::int) n`, [team, point, userId, count, age])
    }
  })
  afterEach(async () => { await client.query('ROLLBACK'); client.release() })
  afterAll(async () => { await pool?.end() })

  it('counts all visits even when another visitor is absent from the first page', async () => {
    const history = await readPointVisitHistory(client, viewer, team, point)
    expect(history.personalCount).toBe(21)
    expect(history.visitors).toEqual(expect.arrayContaining([
      { userId: viewer, displayName: 'Павел', count: 21 },
      { userId: visitor, displayName: 'Аня', count: 25 },
    ]))
    expect(history.entries).toHaveLength(20)
    expect(history.entries.every((entry) => entry.visits.every((visit) => visit.userId === viewer))).toBe(true)
  })

  it('pages only the requested visitor and keeps totals independent of that filter', async () => {
    const first = await readPointVisitHistory(client, viewer, team, point, 0, visitor)
    expect(first.personalCount).toBe(21)
    expect(first.nextOffset).toBe(20)
    const second = await readPointVisitHistory(client, viewer, team, point, first.nextOffset!, visitor)
    expect(second.nextOffset).toBeNull()
    const visits = [...first.entries, ...second.entries].flatMap((entry) => entry.visits)
    expect(visits).toHaveLength(25)
    expect(new Set(visits.map(({ id }) => id)).size).toBe(25)
    expect(visits.every(({ userId }) => userId === visitor)).toBe(true)
    const unknown = await readPointVisitHistory(client, viewer, team, point, 0, randomUUID())
    expect(unknown.entries).toEqual([])
    expect(unknown.nextOffset).toBeNull()
  })

  it('does not grant access through the requested visitor identity', async () => {
    await expect(readPointVisitHistory(client, randomUUID(), team, point, 0, visitor)).rejects.toMatchObject({ statusCode: 404 })
  })
})
