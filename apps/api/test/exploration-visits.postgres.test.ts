import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { IZHEVSK_KB_STORES } from '@kabanda/contracts'
import { readPointProgress } from '../src/exploration-reads.js'
import { readPointVisitHistory } from '../src/point-history.js'

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null
const databaseTests = pool ? describe : describe.skip

databaseTests('cumulative visits across raid lifecycle', () => {
  let client: PoolClient
  let owner: string, member: string, team: string, point: string
  const stableId = IZHEVSK_KB_STORES[0]!.id

  beforeEach(async () => {
    client = await pool!.connect()
    await client.query('BEGIN')
    owner = randomUUID(); member = randomUUID(); team = randomUUID(); point = randomUUID()
    for (const [id, name] of [[owner, 'Вожак'], [member, 'Участник']]) {
      await client.query('INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)', [id, `${id}@example.test`, name])
    }
    await client.query("INSERT INTO kabandas(id,name,owner_id,create_idempotency_key) VALUES($1,'Посещения',$2,$1::uuid::text)", [team, owner])
    await client.query("INSERT INTO kabanda_memberships(kabanda_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [team, owner, member])
    await client.query(`INSERT INTO points(id,kabanda_id,stable_key,name,location,source,source_id,source_url,license,verification_status)
      VALUES($1,$2,$3,'Магазин',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),'kb_store',$3,'https://example.test','test','source_checked')`, [point, team, stableId])
  })
  afterEach(async () => { await client.query('ROLLBACK'); client.release() })
  afterAll(async () => { await pool?.end() })

  async function raid() {
    const id = randomUUID(), snapshot = randomUUID()
    await client.query("INSERT INTO raids(id,kabanda_id,organizer_user_id,title,state,started_at) VALUES($1,$2,$3,'Повторные посещения','active',now()-interval '1 hour')", [id, team, owner])
    await client.query(`INSERT INTO raid_point_snapshots(id,raid_id,source_point_id,name,location,position)
      VALUES($1,$2,$3,'Магазин',ST_SetSRID(ST_MakePoint(53.21,56.86),4326)::geography,0)`, [snapshot, id, point])
    return { id, snapshot }
  }

  async function visit(ride: { id: string; snapshot: string }, user: string, existingCredit?: string) {
    const attempt = randomUUID(), credit = existingCredit ?? randomUUID()
    await client.query(`INSERT INTO raid_checkin_attempts(id,raid_id,point_snapshot_id,actor_user_id,evidence_location,evidence_captured_at,evidence_accuracy_meters,outcome)
      VALUES($1,$2,$3,$4,ST_SetSRID(ST_MakePoint(53.21,56.86),4326)::geography,now()-interval '10 minutes',8,'accepted')`, [attempt, ride.id, ride.snapshot, user])
    if (!existingCredit) await client.query(`INSERT INTO raid_point_credits(id,raid_id,point_snapshot_id,user_id,source,evidence_attempt_id)
      VALUES($1,$2,$3,$4,'gps',$5)`, [credit, ride.id, ride.snapshot, user, attempt])
    await client.query("INSERT INTO raid_point_visit_events(credit_id,evidence_attempt_id,user_id,source) VALUES($1,$2,$3,'gps')", [credit, attempt, user])
    return { credit, attempt }
  }

  async function finish(ride: { id: string }, participants: string[], partial = false) {
    await client.query("UPDATE raids SET state='completed',finalizing_at=now(),finalization_deadline_at=now(),completed_at=now() WHERE id=$1", [ride.id])
    await client.query(`INSERT INTO raid_results(raid_id,kabanda_id,schema_version,partial,started_at,completed_at,team_duration_seconds,team_distance_meters,team_unique_points,team_photos,result_json,share_png,share_sha256)
      VALUES($1,$2,1,$3,now()-interval '1 hour',now(),0,0,1,0,'{}',$4,$5)`, [ride.id, team, partial, Buffer.alloc(64), 'a'.repeat(64)])
    for (const user of participants) {
      await client.query("INSERT INTO raid_result_participants(raid_id,user_id,display_name,duration_seconds,distance_meters,unique_points,photos) VALUES($1,$2,'Участник',0,0,1,0)", [ride.id, user])
      await client.query('INSERT INTO raid_result_points(raid_id,user_id,source_point_id) VALUES($1,$2,$3)', [ride.id, user, point])
    }
  }

  async function counts() {
    const result = await readPointProgress(client, owner, team, { category: 'stores' })
    return result.points.find(row => row.stableId === stableId)
  }

  it('counts repeat visits once each, without doubling them when a raid is finalized', async () => {
    const first = await raid()
    const memberVisit = await visit(first, member)
    const repeated = await visit(first, member, memberVisit.credit)
    await visit(first, owner)
    expect(await counts()).toMatchObject({ personalCount: 1, teamCount: 3 })
    await client.query("UPDATE raids SET state='finalizing',finalizing_at=now(),finalization_deadline_at=now()+interval '1 minute' WHERE id=$1", [first.id])
    expect(await counts()).toMatchObject({ personalCount: 1, teamCount: 3 })
    await finish(first, [owner, member], true)
    expect(await counts()).toMatchObject({ personalCount: 1, teamCount: 3 })
    // Idempotent replay of the already recorded event must not create another visit.
    await client.query("INSERT INTO raid_point_visit_events(credit_id,evidence_attempt_id,user_id,source) VALUES($1,$2,$3,'gps') ON CONFLICT DO NOTHING", [repeated.credit, repeated.attempt, member])
    expect(await counts()).toMatchObject({ personalCount: 1, teamCount: 3 })
    const canonical = await readPointVisitHistory(client, owner, team, point)
    expect(canonical.personalCount).toBe(1)
    expect(canonical.visitors.reduce((sum, visitor) => sum + visitor.count, 0)).toBe(3)
    const second = await raid()
    await visit(second, owner)
    await finish(second, [owner])
    expect(await counts()).toMatchObject({ personalCount: 2, teamCount: 4 })
    // Historical credits are not erased when their author later leaves the team.
    await client.query('UPDATE kabanda_memberships SET removed_at=now() WHERE kabanda_id=$1 AND user_id=$2', [team, member])
    expect(await counts()).toMatchObject({ personalCount: 2, teamCount: 4 })
  })

  it('counts only points accepted into a completed result and ignores cancelled raids', async () => {
    const frozen = await raid()
    await visit(frozen, owner)
    await visit(frozen, member)
    await finish(frozen, [owner], true)
    // The member has an operational credit, but it was not included in this frozen result.
    expect(await counts()).toMatchObject({ personalCount: 1, teamCount: 1 })
    const cancelled = await raid()
    await visit(cancelled, owner)
    await client.query("UPDATE raids SET state='cancelled' WHERE id=$1", [cancelled.id])
    expect(await counts()).toMatchObject({ personalCount: 1, teamCount: 1 })
  })
})
