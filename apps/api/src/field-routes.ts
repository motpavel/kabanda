import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify'
import { z } from 'zod'
import type { AuthService } from './auth.js'
import type { ApiConfig } from './config.js'
import type { FieldRaidService } from './field-service.js'
import { PointMaterialService } from './point-materials.js'

export async function registerFieldRoutes(app:FastifyInstance,deps:{auth:AuthService;config:ApiConfig;raids:FieldRaidService}) {
  const materialService=new PointMaterialService(deps.raids.fieldPool)
  const id=z.uuid(),operation=z.string().trim().min(8).max(100)
  const hash=z.string().regex(/^[a-f0-9]{64}$/)
  const params=z.object({raidId:id,pointId:id.optional(),materialId:id.optional()})
  const evidence=z.object({latitude:z.number().min(56.7).max(57),longitude:z.number().min(53).max(53.4),
    accuracyMeters:z.number().finite().min(0).max(10000),capturedAt:z.iso.datetime({offset:true})})
  const team=z.strictObject({pointSnapshotId:id,evidence,presentParticipantIds:z.array(id).max(20),
    confirmedAttendance:z.literal(true),repeatVisit:z.boolean().optional(),previousAttemptId:id.nullable().optional()})
  const material=z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('comment'),body:z.string().trim().min(1).max(2000)}),
    z.strictObject({kind:z.literal('photo'),body:z.string().trim().max(2000),sourceSha256:hash,
      contentType:z.enum(['image/jpeg','image/png','image/webp']),sizeBytes:z.number().int().min(1).max(8*1024*1024)}),
  ])
  const user=async(request:FastifyRequest,reply:FastifyReply)=>{
    const token=request.cookies[deps.config.cookieName]
    const identity=token?await deps.auth.getUser(token):null
    if(!identity) reply.status(401).send({error:{code:'AUTH_REQUIRED',message:'Нужно войти в аккаунт'}})
    return identity
  }
  app.get('/api/raids/:raidId/fast/live',async(request,reply)=>{
    const actor=await user(request,reply);if(!actor)return
    return reply.header('Cache-Control','private, no-store').send(await deps.raids.getFastSnapshot(actor.id,params.parse(request.params).raidId))
  })
  app.post('/api/raids/:raidId/check-ins/team',async(request,reply)=>{
    const actor=await user(request,reply);if(!actor)return
    return deps.raids.createTeamVisit(actor.id,params.parse(request.params).raidId,team.parse(request.body),operation.parse(request.headers['idempotency-key']))
  })
  app.get('/api/raids/:raidId/points/:pointId/materials',async(request,reply)=>{
    const actor=await user(request,reply);if(!actor)return
    const p=params.parse(request.params),q=z.object({cursor:z.string().regex(/^[1-9][0-9]{0,18}$/).optional()}).parse(request.query)
    return reply.header('Cache-Control','private, no-store').send(await materialService.list(actor.id,p.raidId,p.pointId!,q.cursor))
  })
  app.post('/api/raids/:raidId/points/:pointId/materials',async(request,reply)=>{
    const actor=await user(request,reply);if(!actor)return
    const p=params.parse(request.params)
    return reply.status(201).send(await materialService.create(actor.id,p.raidId,p.pointId!,operation.parse(request.headers['idempotency-key']),material.parse(request.body)))
  })
  app.put('/api/raids/:raidId/points/:pointId/materials/:materialId/content',{bodyLimit:8*1024*1024},async(request,reply)=>{
    const actor=await user(request,reply);if(!actor)return
    const p=params.parse(request.params),sha=hash.parse(request.headers['x-content-sha256'])
    if(!Buffer.isBuffer(request.body))return reply.status(400).send({error:{code:'MEDIA_BODY_REQUIRED',message:'Нужен файл изображения'}})
    return materialService.upload(actor.id,p.raidId,p.pointId!,p.materialId!,request.body,sha)
  })
  app.get('/api/raids/:raidId/points/:pointId/materials/:materialId/content',async(request,reply)=>{
    const actor=await user(request,reply);if(!actor)return
    const p=params.parse(request.params)
    return reply.header('Cache-Control','private, no-store').type('image/jpeg').send(await materialService.read(actor.id,p.raidId,p.pointId!,p.materialId!))
  })
}
