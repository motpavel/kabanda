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
