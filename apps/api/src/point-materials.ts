import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { processMedia, RaidError, type MediaProcessor } from './raids.js'
import { canReadField, fieldAccess, fieldTransaction } from './field-service.js'

export type PointMaterialInput = { kind:'comment';body:string } | {
  kind:'photo';body:string;sourceSha256:string;contentType:'image/jpeg'|'image/png'|'image/webp';sizeBytes:number
}
export type PointMaterial = { id:string;pointSnapshotId:string;authorUserId:string;authorName:string;
  kind:'comment'|'photo';body:string;ready:boolean;width:number|null;height:number|null;createdAt:string }
function projection(row:Record<string,any>):PointMaterial {
  return {id:row.id,pointSnapshotId:row.point_snapshot_id,authorUserId:row.author_user_id,authorName:row.author_name??'',
    kind:row.kind,body:row.body,ready:row.ready,width:row.width??null,height:row.height??null,createdAt:row.created_at.toISOString()}
}
async function authorize(client:PoolClient,userId:string,raidId:string,pointId:string,write=false) {
  const access=await fieldAccess(client,userId,raidId,write)
  if(!canReadField(access) || !['active','paused','finalizing','completed'].includes(access.state)) {
    throw new RaidError('POINT_MATERIALS_UNAVAILABLE',403,'Материалы этой точки недоступны')
  }
  const point=await client.query('SELECT 1 FROM raid_point_snapshots WHERE id=$1 AND raid_id=$2',[pointId,raidId])
  if(!point.rowCount) throw new RaidError('POINT_NOT_FOUND',404,'Точка недоступна')
}

export class PointMaterialService {
  constructor(private readonly pool:Pool,private readonly processor:MediaProcessor=processMedia){}
  async create(userId:string,raidId:string,pointId:string,operationId:string,input:PointMaterialInput) {
    return fieldTransaction(this.pool,async client=>{
      await authorize(client,userId,raidId,pointId,true)
      const old=(await client.query('SELECT * FROM raid_point_materials WHERE author_user_id=$1 AND operation_id=$2',[userId,operationId])).rows[0]
      if(old) {
        if(old.raid_id!==raidId || old.point_snapshot_id!==pointId || old.kind!==input.kind || old.body!==input.body ||
          (input.kind==='photo' && (old.source_sha256!==input.sourceSha256 || old.declared_type!==input.contentType || old.declared_size!==input.sizeBytes))) {
          throw new RaidError('IDEMPOTENCY_CONFLICT',409,'Материал этой операции уже имеет другое содержимое')
        }
        return {material:projection(old)}
      }
      const count=(await client.query('SELECT count(*)::int AS total FROM raid_point_materials WHERE raid_id=$1 AND kind=$2',[raidId,input.kind])).rows[0]!.total
      if(count >= (input.kind==='photo'?100:500)) throw new RaidError('POINT_MATERIAL_LIMIT',409,'Достигнут лимит материалов рейда')
      const row=(await client.query(`INSERT INTO raid_point_materials(raid_id,point_snapshot_id,author_user_id,operation_id,kind,body,source_sha256,declared_type,declared_size,ready)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[raidId,pointId,userId,operationId,input.kind,input.body,
          input.kind==='photo'?input.sourceSha256:null,input.kind==='photo'?input.contentType:null,input.kind==='photo'?input.sizeBytes:null,input.kind==='comment'])).rows[0]!
      return {material:projection(row)}
    })
  }
  async upload(userId:string,raidId:string,pointId:string,materialId:string,bytes:Buffer,contentSha256:string) {
    const preliminary=await fieldTransaction(this.pool,async client=>{
      await authorize(client,userId,raidId,pointId)
      const row=(await client.query(`SELECT * FROM raid_point_materials WHERE id=$1 AND raid_id=$2 AND point_snapshot_id=$3 AND author_user_id=$4`,[materialId,raidId,pointId,userId])).rows[0]
      if(!row || row.kind!=='photo') throw new RaidError('MATERIAL_NOT_FOUND',404,'Фото недоступно')
      if(row.source_sha256!==contentSha256 || bytes.length!==row.declared_size || createHash('sha256').update(bytes).digest('hex')!==contentSha256) {
        throw new RaidError('MATERIAL_CONTENT_MISMATCH',409,'Содержимое фото изменилось')
      }
      return row
    })
    if(preliminary.ready) return {material:projection(preliminary)}
    // Image decoding does not hold a DB connection or the raid lock. Access is
    // rechecked before committing and a concurrent identical upload is a no-op.
    const processed=await this.processor(bytes,preliminary.declared_type)
    return fieldTransaction(this.pool,async client=>{
      await authorize(client,userId,raidId,pointId,true)
      const row=(await client.query(`SELECT * FROM raid_point_materials WHERE id=$1 AND raid_id=$2 AND point_snapshot_id=$3 AND author_user_id=$4 FOR UPDATE`,[materialId,raidId,pointId,userId])).rows[0]
      if(!row) throw new RaidError('MATERIAL_NOT_FOUND',404,'Фото недоступно')
      if(row.ready) return {material:projection(row)}
      const saved=(await client.query(`UPDATE raid_point_materials SET content_bytes=$2,width=$3,height=$4,ready=true WHERE id=$1 RETURNING *`,
        [materialId,processed.data,processed.info.width,processed.info.height])).rows[0]!
      return {material:projection(saved)}
    })
  }
  async list(userId:string,raidId:string,pointId:string,cursor?:string) {
    return fieldTransaction(this.pool,async client=>{
      await authorize(client,userId,raidId,pointId)
      const rows=await client.query(`SELECT m.*,coalesce(u.display_name,u.username::text,split_part(u.email::text,'@',1)) AS author_name
        FROM raid_point_materials m JOIN users u ON u.id=m.author_user_id
        WHERE m.raid_id=$1 AND m.point_snapshot_id=$2 AND m.ready AND ($3::bigint IS NULL OR m.ordinal<$3::bigint)
        ORDER BY m.ordinal DESC LIMIT 25`,[raidId,pointId,cursor??null])
      const page=rows.rows.slice(0,24)
      return {materials:page.map(projection),nextCursor:rows.rows.length>24?String(page.at(-1)!.ordinal):null}
    })
  }
  async read(userId:string,raidId:string,pointId:string,materialId:string) {
    return fieldTransaction(this.pool,async client=>{
      await authorize(client,userId,raidId,pointId)
      const row=(await client.query(`SELECT content_bytes FROM raid_point_materials WHERE id=$1 AND raid_id=$2 AND point_snapshot_id=$3 AND kind='photo' AND ready`,[materialId,raidId,pointId])).rows[0]
      if(!row) throw new RaidError('MATERIAL_NOT_FOUND',404,'Фото недоступно')
      return row.content_bytes as Buffer
    })
  }
}
