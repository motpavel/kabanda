import Dexie,{type Table} from 'dexie'
import {ApiError,requestJson} from '../../lib/http'
import {getActiveIdentityId} from '../offline/ledger'
import {offlineDb} from '../offline/db'
import type {CheckInResponse,OneShotCoordinate} from '../checkins/types'
import {readPhotoUploadBody} from '../checkins/upload-body'

export type TeamPayload={pointSnapshotId:string;evidence:OneShotCoordinate;presentParticipantIds:string[];
  confirmedAttendance:true;repeatVisit?:boolean;previousAttemptId?:string|null}
export type MaterialPayload={kind:'comment';body:string}|{kind:'photo';body:string;sourceSha256:string;contentType:'image/jpeg'|'image/png'|'image/webp';sizeBytes:number}
export type FieldOperation={operationId:string;identityId:string;kabandaId:string;raidId:string;pointId:string;
  kind:'team'|'comment'|'photo';payload:TeamPayload|MaterialPayload;blob?:Blob;
  status:'pending'|'sending'|'retryable'|'accepted'|'rejected';attempts:number;createdAt:number;nextAttemptAt:number;
  claimToken:string|null;claimUntil:number;serverId?:string;response?:unknown;lastError:string|null}
class FieldDb extends Dexie{
  operations!:Table<FieldOperation,string>
  constructor(){super('kabanda-field-operations-v1');this.version(1).stores({operations:'&operationId,[identityId+raidId],status'})}
}
export const fieldDb=new FieldDb()
export const fieldChanged=()=>{if(typeof window!=='undefined')window.dispatchEvent(new Event('kabanda:field-queue-changed'))}
export async function fieldOperations(identityId:string,raidId:string):Promise<FieldOperation[]>{
  if(await getActiveIdentityId()!==identityId)return []
  return fieldDb.operations.where('[identityId+raidId]').equals([identityId,raidId]).sortBy('createdAt')
}
export async function enqueueField(input:Pick<FieldOperation,'identityId'|'kabandaId'|'raidId'|'pointId'|'kind'|'payload'|'blob'>){
  if(await getActiveIdentityId()!==input.identityId)throw new TypeError('Identity changed')
  const operation=await fieldDb.transaction('rw',fieldDb.operations,async()=>{
    const pending=await fieldDb.operations.where('[identityId+raidId]').equals([input.identityId,input.raidId])
      .filter(row=>row.kind==='team'&&input.kind==='team'&&row.pointId===input.pointId&&['pending','sending','retryable'].includes(row.status)).first()
    if(pending){
      if(JSON.stringify(pending.payload)!==JSON.stringify(input.payload))throw new TypeError('Для точки уже отправляется другое подтверждение')
      return pending
    }
    const row:FieldOperation={...input,operationId:crypto.randomUUID(),status:'pending',attempts:0,createdAt:Date.now(),
      nextAttemptAt:0,claimToken:null,claimUntil:0,lastError:null}
    await fieldDb.operations.add(row);return row
  })
  fieldChanged();return operation
}
const flights=new Map<string,Promise<void>>()
const pendingStates=new Set(['pending','retryable','sending'])
async function claim(identityId:string,raidId:string,lane:'team'|'materials'){
  if(await getActiveIdentityId()!==identityId)return null
  return fieldDb.transaction('rw',fieldDb.operations,async()=>{
    const now=Date.now()
    const rows=await fieldDb.operations.where('[identityId+raidId]').equals([identityId,raidId]).sortBy('createdAt')
    const row=rows.find(item=>(lane==='team'?item.kind==='team':item.kind!=='team')&&pendingStates.has(item.status)
      &&item.nextAttemptAt<=now&&(item.status!=='sending'||item.claimUntil<=now))
    if(!row)return null
    const owned:FieldOperation={...row,status:'sending',attempts:row.attempts+1,claimToken:crypto.randomUUID(),claimUntil:now+180000,lastError:null}
    await fieldDb.operations.put(owned);return owned
  })
}
async function updateOwned(owned:FieldOperation,changes:Partial<FieldOperation>){
  if(await getActiveIdentityId()!==owned.identityId)return false
  return fieldDb.transaction('rw',fieldDb.operations,async()=>{
    const current=await fieldDb.operations.get(owned.operationId)
    if(!current||current.status!=='sending'||current.claimToken!==owned.claimToken)return false
    await fieldDb.operations.put({...current,...changes});return true
  })
}
async function bridgeManualAttempt(row:FieldOperation,response:CheckInResponse){
  if(response.outcome==='accepted'||response.reason==='too_far')return
  const payload=row.payload as TeamPayload
  // Only a SERVER-created manual attempt enters the old table, already in
  // needs_action. An old installed client can finish its fallback but cannot
  // reinterpret/replay a v2 group command as an unrelated v1 personal command.
  await offlineDb.transaction('rw',offlineDb.identityContext,offlineDb.checkInOutbox,async()=>{
    if((await offlineDb.identityContext.get('active'))?.userId!==row.identityId)return
    if(await offlineDb.checkInOutbox.get(row.operationId))return
    await offlineDb.checkInOutbox.add({operationId:row.operationId,identityId:row.identityId,kabandaId:row.kabandaId,raidId:row.raidId,
      pointSnapshotId:payload.pointSnapshotId,evidence:payload.evidence,presentParticipantIds:payload.presentParticipantIds,
      organizerAttestation:false,repeatVisit:!!payload.repeatVisit,status:'needs_action',attempts:row.attempts,claimUntil:null,
      nextAttemptAt:null,createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date().toISOString(),lastErrorCode:response.reason,response})
  })
}
async function deliver(row:FieldOperation){
  if(await getActiveIdentityId()!==row.identityId)throw new TypeError('Identity changed')
  const base=`/api/raids/${encodeURIComponent(row.raidId)}`
  if(row.kind==='team'){
    const response=await requestJson<CheckInResponse>(`${base}/check-ins/team`,{
      method:'POST',headers:{'Idempotency-Key':row.operationId},body:JSON.stringify(row.payload)})
    if(response.operationId!==row.operationId||response.point?.pointSnapshotId!==row.pointId||!['accepted','needs_manual_verification'].includes(response.outcome))throw new TypeError('Invalid visit response')
    await bridgeManualAttempt(row,response)
    await updateOwned(row,{status:response.reason==='too_far'?'rejected':'accepted',response,claimToken:null,claimUntil:0,lastError:response.reason})
    return
  }
  const path=`${base}/points/${encodeURIComponent(row.pointId)}/materials`
  const intent=await requestJson<{material:{id:string;ready:boolean}}>(path,{
    method:'POST',headers:{'Idempotency-Key':row.operationId},body:JSON.stringify(row.payload)})
  if(!intent.material?.id)throw new TypeError('Invalid material response')
  if(!await updateOwned(row,{serverId:intent.material.id}))return
  let response:unknown=intent
  if(row.kind==='photo'&&!intent.material.ready){
    if(!row.blob||!('sourceSha256'in row.payload))throw new TypeError('Missing saved photograph')
    const bytes=await readPhotoUploadBody(row.blob)
    if(await getActiveIdentityId()!==row.identityId)return
    response=await requestJson(`${path}/${encodeURIComponent(intent.material.id)}/content`,{
      method:'PUT',headers:{'content-type':row.blob.type,'x-content-sha256':row.payload.sourceSha256},body:bytes})
  }
  await updateOwned(row,{status:'accepted',response,claimToken:null,claimUntil:0,lastError:null})
}
export function pumpFieldOperations(identityId:string,raidId:string,lane:'team'|'materials',online=true):Promise<void>{
  if(!online)return Promise.resolve()
  const key=JSON.stringify([identityId,raidId,lane])
  const running=flights.get(key);if(running)return running
  const job=(async()=>{
    for(let index=0;index<8;index++){
      const row=await claim(identityId,raidId,lane);if(!row)return
      fieldChanged()
      try{await deliver(row)}catch(error){
        const terminal=error instanceof ApiError&&error.status>=400&&error.status<500&&![401,408,429].includes(error.status)
        const delay=[2000,5000,15000,30000][Math.min(row.attempts-1,3)]!
        await updateOwned(row,{status:terminal?'rejected':'retryable',claimToken:null,claimUntil:0,nextAttemptAt:Date.now()+delay,
          lastError:error instanceof ApiError?error.code:'NETWORK_ERROR'})
        if(!terminal)return
      }finally{fieldChanged()}
    }
  })().finally(()=>{if(flights.get(key)===job)flights.delete(key)})
  flights.set(key,job);return job
}
export async function fieldInventory(identityId:string,raidId:string){
  const rows=await fieldOperations(identityId,raidId)
  return {teamPending:rows.filter(row=>row.kind==='team'&&pendingStates.has(row.status)).length,
    materialPending:rows.filter(row=>row.kind!=='team'&&pendingStates.has(row.status)).length,
    teamRejected:rows.filter(row=>row.kind==='team'&&row.status==='rejected'&&row.lastError!=='too_far'&&row.lastError!=='TEAM_VISIT_ALREADY_CONFIRMED').length}
}
