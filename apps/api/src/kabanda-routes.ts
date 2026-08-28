import {
  acceptInviteContinuationSchema,
  createInviteSchema,
  createKabandaSchema,
  idempotencyKeySchema,
  pointListQuerySchema,
  previewInviteSchema,
} from '@kabanda/contracts'
import type { GeographicBounds } from '@kabanda/domain'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AuthService } from './auth.js'
import type { ApiConfig } from './config.js'
import type { KabandaService } from './kabandas.js'

type RouteDependencies = {
  auth: AuthService
  config: ApiConfig
  kabandas: KabandaService
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

function idempotencyKey(request: FastifyRequest): string {
  return idempotencyKeySchema.parse(request.headers['idempotency-key'])
}

function pendingInviteCookieName(config: ApiConfig): string {
  return config.secureCookies ? '__Host-kabanda_pending_invite' : 'kabanda_pending_invite'
}

function parseBounds(raw: string): GeographicBounds {
  const values = raw.split(',').map(Number)
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    return { minLon: Number.NaN, minLat: Number.NaN, maxLon: Number.NaN, maxLat: Number.NaN }
  }
  const [minLon, minLat, maxLon, maxLat] = values
  return { minLon: minLon!, minLat: minLat!, maxLon: maxLon!, maxLat: maxLat! }
}

export async function registerKabandaRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): Promise<void> {
  app.get('/api/kabandas', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    return { kabandas: await dependencies.kabandas.listKabandas(user.id) }
  })

  app.post('/api/kabandas', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const input = createKabandaSchema.parse(request.body)
    const kabanda = await dependencies.kabandas.createKabanda(
      user.id,
      input.name,
      input.avatar,
      idempotencyKey(request),
    )
    return reply.status(201).send({ kabanda })
  })

  app.get('/api/kabandas/:id/members', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const id = resourceIdSchema.parse((request.params as { id: string }).id)
    return { members: await dependencies.kabandas.listMembers(user.id, id) }
  })

  app.delete('/api/kabandas/:id/members/me', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const id = resourceIdSchema.parse((request.params as { id: string }).id)
    await dependencies.kabandas.leaveKabanda(user.id, id)
    return reply.status(204).send()
  })

  app.delete('/api/kabandas/:id/members/:memberId', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const params = request.params as { id: string; memberId: string }
    const id = resourceIdSchema.parse(params.id)
    const memberId = resourceIdSchema.parse(params.memberId)
    await dependencies.kabandas.removeMember(user.id, id, memberId)
    return reply.status(204).send()
  })

  app.post('/api/kabandas/:id/invites', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const id = resourceIdSchema.parse((request.params as { id: string }).id)
    const input = createInviteSchema.parse(request.body)
    const invite = await dependencies.kabandas.createInvite(user.id, id, input.expiresInHours)
    return reply.status(201).send({ invite })
  })

  app.delete('/api/kabandas/:id/invites/:inviteId', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const params = request.params as { id: string; inviteId: string }
    const id = resourceIdSchema.parse(params.id)
    const inviteId = resourceIdSchema.parse(params.inviteId)
    await dependencies.kabandas.revokeInvite(user.id, id, inviteId)
    return reply.status(204).send()
  })

  app.post('/api/invites/preview', async (request, reply) => {
    const input = previewInviteSchema.parse(request.body)
    const user = await currentUser(request, dependencies)
    const pendingCookie = pendingInviteCookieName(dependencies.config)
    const invite = 'token' in input
      ? await dependencies.kabandas.previewInvite(input.token, !user)
      : 'continuation' in input
        ? await dependencies.kabandas.previewContinuation(input.continuation, !user, user?.id)
        : request.cookies[pendingCookie]
          ? await dependencies.kabandas.previewContinuation(request.cookies[pendingCookie]!, !user, user?.id)
          : null
    if (!invite) {
      return reply.status(400).send({
        error: { code: 'INVITE_INVALID', message: 'Приглашение недействительно' },
      })
    }
    if (!invite.accepted) {
      reply.setCookie(pendingCookie, invite.continuation, {
        httpOnly: true,
        sameSite: 'lax',
        secure: dependencies.config.secureCookies,
        path: '/',
        maxAge: 30 * 60,
      })
    }
    return { invite }
  })

  app.post('/api/invites/accept', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const input = acceptInviteContinuationSchema.parse(request.body)
    const kabanda = await dependencies.kabandas.acceptInvite(
      user.id,
      input.continuation,
      idempotencyKey(request),
    )
    return { kabanda }
  })

  app.get('/api/points', async (request, reply) => {
    const user = await currentUser(request, dependencies)
    if (!user) return authRequired(reply)
    const input = pointListQuerySchema.parse(request.query)
    return dependencies.kabandas.listPoints(
      user.id,
      input.collection,
      parseBounds(input.bbox),
      input.limit,
    )
  })
}
