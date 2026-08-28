import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AuthService } from './auth.js'
import type { ApiConfig } from './config.js'
import type { RaidAction } from '@kabanda/domain'
import type { RaidCommandInput, RaidService } from './raids.js'

type RouteDependencies = {
  auth: AuthService
  config: ApiConfig
  raids: RaidService
}

const resourceIdSchema = z.uuid()
const operationIdSchema = z.string().trim().min(8).max(100)
const createRaidSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(),
})
const commandSchema = z.object({ expectedVersion: z.coerce.number().int().positive() })
const assignNavigatorSchema = commandSchema.extend({ navigatorUserId: z.uuid() })
const navigatorLeaseSchema = commandSchema.extend({ clientInstanceId: z.uuid() })
const readinessSchema = commandSchema.extend({
  appMode: z.enum(['browser', 'standalone']),
  locationPermission: z.enum(['granted', 'prompt', 'denied', 'unsupported', 'unknown']),
  coordinateMeasuredAt: z.iso.datetime({ offset: true }).nullable(),
  accuracyM: z.coerce.number().min(0).max(10_000).nullable(),
  indexedDbWritable: z.boolean(),
  storageAvailable: z.boolean().nullable(),
  online: z.boolean(),
  measuredAt: z.iso.datetime({ offset: true }),
})
const actionableQuerySchema = z.object({ scope: z.literal('actionable') })
const routeBatchSchema = z.object({
  schemaVersion: z.literal(1),
  leaseId: z.uuid(),
  clientInstanceId: z.uuid(),
  samples: z
    .array(
      z.object({
        operationId: z.string().trim().min(8).max(100),
        sequence: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        capturedAt: z.iso.datetime({ offset: true }),
        latitude: z.coerce.number().min(56.7).max(57),
        longitude: z.coerce.number().min(53).max(53.4),
        accuracyM: z.coerce.number().min(0).max(10_000),
        speedMps: z.coerce.number().min(0).max(100).optional(),
        headingDeg: z.coerce.number().min(0).lt(360).optional(),
      }),
    )
    .min(1)
    .max(50),
})
const nearbySchema = z.object({
  latitude: z.coerce.number().min(56.7).max(57),
  longitude: z.coerce.number().min(53).max(53.4),
  limit: z.coerce.number().int().min(1).max(5).default(5),
})
const presentParticipantIdsSchema = z.array(z.uuid()).max(20).default([])
const checkinSchema = z.object({
  pointSnapshotId: z.uuid(),
  evidence: z.object({
    latitude: z.coerce.number().min(56.7).max(57),
    longitude: z.coerce.number().min(53).max(53.4),
    capturedAt: z.iso.datetime({ offset: true }),
    accuracyMeters: z.coerce.number().min(0).max(10_000),
  }),
  presentParticipantIds: presentParticipantIdsSchema,
  organizerAttestation: z.boolean(),
})
const pendingQuerySchema = z.object({ status: z.literal('pending') })
const fallbackSchema = z.object({
  attemptId: z.uuid(),
  mediaId: z.uuid(),
  verifierUserId: z.uuid(),
  presentParticipantIds: presentParticipantIdsSchema,
  reason: z.string().trim().min(1).max(240),
})
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const mediaIntentSchema = z.object({
  sourceSha256: sha256Schema,
  sizeBytes: z.coerce.number().int().min(1).max(8 * 1024 * 1024),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  caption: z.string().trim().max(160).nullable().optional(),
  purpose: z.enum(['gallery', 'fallback']),
  attemptId: z.uuid().optional(),
})
const mediaListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(24),
  cursor: z.string().trim().max(200).optional(),
})

function authRequired(reply: FastifyReply) {
  return reply.status(401).send({
    error: { code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' },
  })
}

async function currentUser(request: FastifyRequest, dependencies: RouteDependencies) {
  const token = request.cookies[dependencies.config.cookieName]
  return token ? dependencies.auth.getUser(token) : null
}

function operationId(request: FastifyRequest): string {
  return operationIdSchema.parse(request.headers['idempotency-key'])
}

async function execute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: RouteDependencies,
  action: RaidAction,
  input: RaidCommandInput,
) {
  const user = await currentUser(request, dependencies)
  if (!user) return authRequired(reply)
  const raidId = resourceIdSchema.parse((request.params as { raidId: string }).raidId)
  return dependencies.raids.command(user.id, raidId, action, input, operationId(request))
}

export async function registerRaidRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): Promise<void> {
  app.post('/api/kabandas/:kabandaId/raids', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const kabandaId = resourceIdSchema.parse(
      (request.params as { kabandaId: string }).kabandaId,
    )
    const input = createRaidSchema.parse(request.body)
    const response = await dependencies.raids.createDraft(
      user.id,
      kabandaId,
      input,
      operationId(request),
    )
    return reply.status(201).send(response)
  })

  app.get('/api/raids/current', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    return { raid: await dependencies.raids.getCurrent(user.id) }
  })

  app.get('/api/kabandas/:kabandaId/raids', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    actionableQuerySchema.parse(request.query)
    const kabandaId = resourceIdSchema.parse(
      (request.params as { kabandaId: string }).kabandaId,
    )
    return { raids: await dependencies.raids.listActionable(user.id, kabandaId) }
  })

  app.get('/api/raids/:raidId', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const raidId = resourceIdSchema.parse((request.params as { raidId: string }).raidId)
    return { raid: await dependencies.raids.getRaid(user.id, raidId) }
  })

  app.get('/api/raids/:raidId/check-ins/nearby', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const raidId = resourceIdSchema.parse((request.params as { raidId: string }).raidId)
    return dependencies.raids.nearbyCheckins(user.id, raidId, nearbySchema.parse(request.query))
  })

  app.post('/api/raids/:raidId/check-ins', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const raidId = resourceIdSchema.parse((request.params as { raidId: string }).raidId)
    return dependencies.raids.createCheckin(
      user.id,
      raidId,
      checkinSchema.parse(request.body),
      operationId(request),
    )
  })

  app.get('/api/raids/:raidId/check-in-claims', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    pendingQuerySchema.parse(request.query)
    const raidId = resourceIdSchema.parse((request.params as { raidId: string }).raidId)
    return dependencies.raids.listPendingClaims(user.id, raidId)
  })

  for (const decision of ['confirm', 'decline'] as const) {
    app.post(`/api/raids/:raidId/check-in-claims/:claimId/${decision}`, async (request, reply) => {
      const user = await currentUser(request, dependencies)
      if (!user) return authRequired(reply)
      const params = request.params as { raidId: string; claimId: string }
      return dependencies.raids.respondClaim(
        user.id,
        resourceIdSchema.parse(params.raidId),
        resourceIdSchema.parse(params.claimId),
        decision,
        operationId(request),
      )
    })
  }

  app.post('/api/raids/:raidId/check-in-fallbacks', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const raidId = resourceIdSchema.parse((request.params as { raidId: string }).raidId)
    return dependencies.raids.createFallback(
      user.id,
      raidId,
      fallbackSchema.parse(request.body),
      operationId(request),
    )
  })

  app.get('/api/raids/:raidId/check-in-fallbacks', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    pendingQuerySchema.parse(request.query)
    const raidId = resourceIdSchema.parse((request.params as { raidId: string }).raidId)
    return dependencies.raids.listPendingFallbacks(user.id, raidId)
  })

  for (const decision of ['confirm', 'decline'] as const) {
    app.post(`/api/raids/:raidId/check-in-fallbacks/:fallbackId/${decision}`, async (request, reply) => {
      const user = await currentUser(request, dependencies)
      if (!user) return authRequired(reply)
      const params = request.params as { raidId: string; fallbackId: string }
      return dependencies.raids.respondFallback(
        user.id,
        resourceIdSchema.parse(params.raidId),
        resourceIdSchema.parse(params.fallbackId),
        decision,
        operationId(request),
      )
    })
  }

  app.post('/api/raids/:raidId/media/intents', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const raidId = resourceIdSchema.parse((request.params as { raidId: string }).raidId)
    const response = await dependencies.raids.createMediaIntent(
      user.id,
      raidId,
      mediaIntentSchema.parse(request.body),
      operationId(request),
    )
    return reply.status(201).send(response)
  })

  app.put(
    '/api/raids/:raidId/media/intents/:intentId/content',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const user = await currentUser(request, dependencies)
      if (!user) return authRequired(reply)
      const params = request.params as { raidId: string; intentId: string }
      const capability = z.string().min(32).max(160).parse(request.headers['x-upload-capability'])
      const contentSha256 = sha256Schema.parse(request.headers['x-content-sha256'])
      if (!Buffer.isBuffer(request.body)) {
        return reply.status(400).send({
          error: { code: 'MEDIA_BODY_REQUIRED', message: 'Нужен файл изображения' },
        })
      }
      return dependencies.raids.uploadMedia(
        user.id,
        resourceIdSchema.parse(params.raidId),
        resourceIdSchema.parse(params.intentId),
        capability,
        contentSha256,
        request.body,
      )
    },
  )

  app.get('/api/raids/:raidId/media', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const raidId = resourceIdSchema.parse((request.params as { raidId: string }).raidId)
    const query = mediaListSchema.parse(request.query)
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await dependencies.raids.listMedia(user.id, raidId, query.limit, query.cursor))
  })

  app.get('/api/raids/:raidId/media/:mediaId/content', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const params = request.params as { raidId: string; mediaId: string }
    const media = await dependencies.raids.readMedia(
      user.id,
      resourceIdSchema.parse(params.raidId),
      resourceIdSchema.parse(params.mediaId),
    )
    return reply
      .header('Cache-Control', 'private, no-store')
      .type(media.contentType)
      .send(media.bytes)
  })

  app.delete('/api/raids/:raidId/media/:mediaId', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const params = request.params as { raidId: string; mediaId: string }
    return dependencies.raids.tombstoneMedia(
      user.id,
      resourceIdSchema.parse(params.raidId),
      resourceIdSchema.parse(params.mediaId),
      operationId(request),
    )
  })

  app.post('/api/raids/:raidId/commands/open-lobby', async (request, reply) =>
    execute(request, reply, dependencies, 'open-lobby', commandSchema.parse(request.body)),
  )
  app.post('/api/raids/:raidId/participants/me/accept', async (request, reply) =>
    execute(request, reply, dependencies, 'accept', commandSchema.parse(request.body)),
  )
  app.post('/api/raids/:raidId/participants/me/decline', async (request, reply) =>
    execute(request, reply, dependencies, 'decline', commandSchema.parse(request.body)),
  )
  app.post('/api/raids/:raidId/participants/me/ready', async (request, reply) => {
    return execute(request, reply, dependencies, 'ready', commandSchema.parse(request.body))
  })
  app.post('/api/raids/:raidId/readiness', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const raidId = resourceIdSchema.parse((request.params as { raidId: string }).raidId)
    const input = readinessSchema.parse(request.body)
    return dependencies.raids.reportReadiness(user.id, raidId, input, operationId(request))
  })
  app.post('/api/raids/:raidId/commands/assign-navigator', async (request, reply) => {
    const input = assignNavigatorSchema.parse(request.body)
    return execute(request, reply, dependencies, 'assign-navigator', input)
  })
  app.post('/api/raids/:raidId/commands/handoff-navigator', async (request, reply) => {
    const input = assignNavigatorSchema.parse(request.body)
    return execute(request, reply, dependencies, 'handoff-navigator', input)
  })
  app.post('/api/raids/:raidId/route/lease/acquire', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const raidId = resourceIdSchema.parse((request.params as { raidId: string }).raidId)
    return dependencies.raids.acquireNavigatorLease(
      user.id,
      raidId,
      navigatorLeaseSchema.parse(request.body),
      operationId(request),
    )
  })
  app.post('/api/raids/:raidId/route/lease/recover', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const raidId = resourceIdSchema.parse((request.params as { raidId: string }).raidId)
    return dependencies.raids.recoverNavigatorLease(
      user.id,
      raidId,
      navigatorLeaseSchema.parse(request.body),
      operationId(request),
    )
  })
  app.post(
    '/api/raids/:raidId/route/batches',
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const user = await currentUser(request, dependencies)
      if (!user) return authRequired(reply)
      const raidId = resourceIdSchema.parse((request.params as { raidId: string }).raidId)
      return dependencies.raids.submitRouteBatch(
        user.id,
        raidId,
        routeBatchSchema.parse(request.body),
        operationId(request),
      )
    },
  )
  app.post('/api/raids/:raidId/commands/start', async (request, reply) =>
    execute(request, reply, dependencies, 'start', commandSchema.parse(request.body)),
  )
  app.post('/api/raids/:raidId/commands/pause', async (request, reply) =>
    execute(request, reply, dependencies, 'pause', commandSchema.parse(request.body)),
  )
  app.post('/api/raids/:raidId/commands/resume', async (request, reply) =>
    execute(request, reply, dependencies, 'resume', commandSchema.parse(request.body)),
  )
  app.post('/api/raids/:raidId/commands/cancel', async (request, reply) =>
    execute(request, reply, dependencies, 'cancel', commandSchema.parse(request.body)),
  )
}
