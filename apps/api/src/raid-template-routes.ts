import { createRaidTemplateSchema, idempotencyKeySchema } from '@kabanda/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AuthService } from './auth.js'
import type { ApiConfig } from './config.js'
import type { RaidTemplateService } from './raid-templates.js'

type RouteDependencies = {
  auth: AuthService
  config: ApiConfig
  raidTemplates: RaidTemplateService
}

const resourceIdSchema = z.uuid()

function authRequired(reply: FastifyReply) {
  return reply.status(401).send({
    error: { code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' },
  })
}

async function currentUser(request: FastifyRequest, dependencies: RouteDependencies) {
  const token = request.cookies[dependencies.config.cookieName]
  return token ? dependencies.auth.getUser(token) : null
}

export async function registerRaidTemplateRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): Promise<void> {
  app.post(
    '/api/kabandas/:kabandaId/raid-templates',
    { bodyLimit: 768 * 1024 },
    async (request, reply) => {
      const user = await currentUser(request, dependencies)
      if (!user) return authRequired(reply)
      const kabandaId = resourceIdSchema.parse(
        (request.params as { kabandaId: string }).kabandaId,
      )
      const operationId = idempotencyKeySchema.parse(request.headers['idempotency-key'])
      const input = createRaidTemplateSchema.parse(request.body)
      const response = await dependencies.raidTemplates.createTemplate(
        user.id,
        kabandaId,
        input,
        operationId,
      )
      return reply
        .header('Cache-Control', 'private, no-store')
        .status(201)
        .send(response)
    },
  )

  app.get('/api/kabandas/:kabandaId/raid-templates', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const kabandaId = resourceIdSchema.parse(
      (request.params as { kabandaId: string }).kabandaId,
    )
    const templates = await dependencies.raidTemplates.listTemplates(user.id, kabandaId)
    return reply
      .header('Cache-Control', 'private, no-store')
      .send({ templates })
  })

  app.get('/api/raid-templates/:templateId', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const templateId = resourceIdSchema.parse(
      (request.params as { templateId: string }).templateId,
    )
    const template = await dependencies.raidTemplates.getTemplate(user.id, templateId)
    return reply
      .header('Cache-Control', 'private, no-store')
      .send({ template })
  })

  app.get('/api/raid-templates/:templateId/cover', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const templateId = resourceIdSchema.parse(
      (request.params as { templateId: string }).templateId,
    )
    const cover = await dependencies.raidTemplates.readCover(user.id, templateId)
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('ETag', `"${cover.sha256}"`)
      .type(cover.contentType)
      .send(cover.bytes)
  })
}
