import { afterAll, describe, expect, it } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { Pool } from 'pg'
import { DatabaseKabandaService } from '../src/kabandas.js'
import { DatabaseRaidService } from '../src/raids.js'
import { DatabaseRaidTemplateService } from '../src/raid-templates.js'

const pool = process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL}) : null
const suite = pool ? describe : describe.skip
suite('raid route selection', () => {
  afterAll(async () => { await pool?.end() })
  it('freezes the chosen order; respects private access and idempotency', async () => {
    const db = pool!
    const users = await db.query<{id:string}>(`INSERT INTO users (email) VALUES ($1),($2) RETURNING id`,[`${randomUUID()}@example.test`,`${randomUUID()}@example.test`])
    const owner = users.rows[0]!.id, outsider = users.rows[1]!.id
    const teams = new DatabaseKabandaService(db)
    const team = await teams.createKabanda(owner,'Route regression','🐗',randomUUID())
    const other = await teams.createKabanda(outsider,'Other regression','🐗',randomUUID())
    const bytes=Buffer.from([0xff,0xd8,0xff,0xd9])
    const templates = new DatabaseRaidTemplateService(db,async()=>({bytes,contentType:'image/jpeg',sizeBytes:bytes.length,width:1280,height:720,sha256:createHash('sha256').update(bytes).digest('hex')}))
    const {template} = await templates.createTemplate(owner,team.id,{scope:'kabanda',title:'Ordered',coverImage:'data:image/jpeg;base64,test',points:[
      {name:'First',address:'First',comment:'',latitude:56.86,longitude:53.21},
      {name:'Second',address:'Second',comment:'',latitude:56.8602,longitude:53.211},
    ]},randomUUID())
    const raids=new DatabaseRaidService(db,'local-test-media-secret-at-least-32-bytes')
    const key=randomUUID()
    const input={title:'Selected',routeTemplateId:template.id}
    const created=await raids.createDraft(owner,team.id,input,key)
    expect(created.raid.routeTemplateId).toBe(template.id)
    expect((await raids.createDraft(owner,team.id,input,key)).raid.id).toBe(created.raid.id)
    await expect(raids.createDraft(owner,team.id,{title:'Selected'},key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'})
    await expect(raids.createDraft(outsider,other.id,input,randomUUID())).rejects.toMatchObject({statusCode:404})
    await db.query(`INSERT INTO kabanda_memberships (kabanda_id,user_id,role) VALUES ($1,$2,'member')`,[other.id,owner])
    await expect(raids.createDraft(owner,other.id,input,randomUUID())).rejects.toMatchObject({statusCode:404})
    await db.query(`UPDATE raid_template_points SET name='Changed later' WHERE template_id=$1`,[template.id])
    const snapshots=await db.query(`SELECT name,position FROM raid_point_snapshots WHERE raid_id=$1 ORDER BY position`,[created.raid.id])
    expect(snapshots.rows).toEqual([{name:'First',position:0},{name:'Second',position:1}])
    // The active state is a fixture here: this regression exercises check-in
    // policy, while the full start/presence path is covered by the golden test.
    await db.query("UPDATE raids SET state='active', started_at=now() WHERE id=$1", [created.raid.id])
    await db.query("UPDATE raid_participants SET state='active', active_from=now() WHERE raid_id=$1", [created.raid.id])
    const selectedPoint = (await db.query('SELECT id,source_point_id FROM raid_point_snapshots WHERE raid_id=$1 ORDER BY position', [created.raid.id])).rows[0]
    const checkin = { pointSnapshotId: selectedPoint.id, evidence: {latitude:56.86,longitude:53.21,capturedAt:new Date().toISOString(),accuracyMeters:8}, presentParticipantIds:[],organizerAttestation:false }
    await raids.createCheckin(owner,created.raid.id,checkin,randomUUID())
    await raids.createCheckin(owner,created.raid.id,checkin,randomUUID())
    await expect(raids.createCheckin(owner,created.raid.id,{...checkin,repeatVisit:true},randomUUID())).rejects.toMatchObject({code:'RAID_REPEAT_NOT_ALLOWED'})
    expect((await teams.getPointVisitHistory(owner,team.id,selectedPoint.source_point_id)).personalCount).toBe(1)
    expect((await raids.getMapPoints(owner,created.raid.id)).points).toContainEqual(expect.objectContaining({id:selectedPoint.id,visitedByMe:true}))
    const free=await raids.createDraft(owner,team.id,{title:'Free'},randomUUID())
    expect(free.raid.routeTemplateId).toBeNull()
    expect((await db.query(`SELECT 1 FROM raid_point_snapshots WHERE raid_id=$1`,[free.raid.id])).rowCount).toBe(0)
  })
})
