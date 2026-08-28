import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import {
  requestMagicLinkSchema,
  updateProfileSchema,
  verifyMagicLinkSchema,
} from '@kabanda/contracts'
import Fastify, { LogController, type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import type { AuthService } from './auth.js'
import type { ApiConfig } from './config.js'
import { registerKabandaRoutes } from './kabanda-routes.js'
import { KabandaError, type KabandaService } from './kabandas.js'
import { registerRaidRoutes } from './raid-routes.js'
import { RaidError, type RaidService } from './raids.js'

export interface AppDependencies {
  auth: AuthService
  kabandas: KabandaService
  raids?: RaidService
  config: ApiConfig
  readiness: () => Promise<void>
}

function unauthorized() {
  return { error: { code: 'AUTH_REQUIRED', message: 'Нужно войти в КАБАНДУ' } }
}

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: dependencies.config.NODE_ENV !== 'test',
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 128 * 1024,
    requestTimeout: 10_000,
  })
  await app.register(cookie)
  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(rateLimit, { global: false })

  app.addHook('onRequest', async (request, reply) => {
    if (
      request.url.startsWith('/api/') &&
      !safeMethods.has(request.method) &&
      request.headers.origin !== dependencies.config.APP_ORIGIN
    ) {
      return reply.status(403).send({
        error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Источник запроса не разрешён' },
      })
    }
  })

  app.addHook('onResponse', async (request, reply) => {
    if (dependencies.config.NODE_ENV === 'test') return
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    )
  })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'INVALID_INPUT', message: 'Проверьте введённые данные' },
      })
    }
    if (error instanceof KabandaError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      })
    }
    if (error instanceof RaidError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      })
    }
    app.log.error(error)
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Не удалось выполнить запрос' },
    })
  })

  app.get('/api/health', async () => ({ status: 'ok', service: 'kabanda-api' }))

  app.get('/api/ready', async (_request, reply) => {
    await dependencies.readiness()
    return reply.send({ status: 'ready' })
  })

  app.post(
    '/api/auth/request-link',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = requestMagicLinkSchema.parse(request.body)
      await dependencies.auth.requestMagicLink(input.email, input.returnTo)
      return reply.status(202).send({ accepted: true })
    },
  )

  app.post('/api/auth/verify', async (request, reply) => {
    const input = verifyMagicLinkSchema.parse(request.body)
    const session = await dependencies.auth.verifyMagicLink(input.token)
    if (!session) {
      return reply.status(400).send({
        error: { code: 'MAGIC_LINK_INVALID', message: 'Ссылка недействительна или уже использована' },
      })
    }

    reply.setCookie(dependencies.config.cookieName, session.rawToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: dependencies.config.secureCookies,
      path: '/',
      maxAge: dependencies.config.SESSION_TTL_DAYS * 24 * 60 * 60,
    })
    return { returnTo: session.returnTo }
  })

  app.get('/api/me', async (request, reply) => {
    const token = request.cookies[dependencies.config.cookieName]
    if (!token) return reply.status(401).send(unauthorized())
    const user = await dependencies.auth.getUser(token)
    if (!user) return reply.status(401).send(unauthorized())
    return { user }
  })

  app.patch('/api/me', async (request, reply) => {
    const token = request.cookies[dependencies.config.cookieName]
    if (!token) return reply.status(401).send(unauthorized())
    const profile = updateProfileSchema.parse(request.body)
    const user = await dependencies.auth.updateProfile(token, profile)
    if (!user) return reply.status(401).send(unauthorized())
    return { user }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[dependencies.config.cookieName]
    if (token) await dependencies.auth.revokeSession(token)
    reply.clearCookie(dependencies.config.cookieName, {
      httpOnly: true,
      sameSite: 'lax',
      secure: dependencies.config.secureCookies,
      path: '/',
    })
    return reply.status(204).send()
  })

  await registerKabandaRoutes(app, dependencies)
  if (dependencies.raids) await registerRaidRoutes(app, { ...dependencies, raids: dependencies.raids })

  return app
}
