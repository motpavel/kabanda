import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  alphaDiagnosticSignalSchema,
  buildIdentifierSchema,
  passwordLoginSchema,
  requestMagicLinkSchema,
  updateProfileSchema,
  verifyMagicLinkSchema,
} from '@kabanda/contracts'
import type { AlphaDiagnosticSignal } from '@kabanda/contracts'
import Fastify, { LogController, type FastifyInstance } from 'fastify'
import { z, ZodError } from 'zod'
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
  onDiagnosticSignal?: (signal: AlphaDiagnosticSignal) => void
}

function unauthorized() {
  return { error: { code: 'AUTH_REQUIRED', message: 'Нужно войти в КАБАНДУ' } }
}

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

function isApiPath(url: string): boolean {
  return /^\/api(?:\/|$)/.test(new URL(url, 'http://kabanda.local').pathname)
}

export function privacySafeOperationRef(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function requestOperationRef(request: { headers: Record<string, unknown> }): string | undefined {
  const value = request.headers['idempotency-key']
  return typeof value === 'string' ? privacySafeOperationRef(value) : undefined
}

function boundedHeader(
  value: string | string[] | undefined,
  validator: { safeParse: (input: unknown) => { success: boolean } },
): string | undefined {
  return typeof value === 'string' && validator.safeParse(value).success ? value : undefined
}

function latencyBucket(milliseconds: number): string {
  if (milliseconds < 100) return 'lt_100ms'
  if (milliseconds < 500) return '100_499ms'
  if (milliseconds < 2_000) return '500_1999ms'
  return '2s_plus'
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const publicOrigin = new URL(dependencies.config.APP_ORIGIN)
  const app = Fastify({
    logger: dependencies.config.NODE_ENV !== 'test',
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    bodyLimit: 128 * 1024,
    requestTimeout: 10_000,
    trustProxy: dependencies.config.TRUST_PROXY_ADDRESS ?? false,
  })
  await app.register(cookie)
  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(rateLimit, { global: false })
  if (dependencies.config.PWA_DIST_DIR) {
    await app.register(fastifyStatic, {
      root: dependencies.config.PWA_DIST_DIR,
      cacheControl: false,
      setHeaders(reply, pathName) {
        const fileName = basename(pathName)
        if (
          pathName.includes('/assets/') ||
          /^(?:workbox|sw-build)-[A-Za-z0-9._-]+\.js$/.test(fileName)
        ) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable')
        } else if (
          fileName === 'index.html' ||
          fileName === 'sw.js' ||
          fileName.endsWith('.webmanifest')
        ) {
          reply.header('Cache-Control', 'no-store')
        } else {
          reply.header('Cache-Control', 'no-cache')
        }
      },
    })
  }
  app.addContentTypeParser(
    ['application/octet-stream', 'image/jpeg', 'image/png', 'image/webp'],
    { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  )

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Kabanda-Request-Id', request.id)
    reply.header('X-Kabanda-Api-Build', dependencies.config.API_BUILD_ID)
    reply.header('X-Kabanda-App-Build', dependencies.config.API_BUILD_ID)
    reply.header(
      'Permissions-Policy',
      'camera=(self), geolocation=(self), screen-wake-lock=(self)',
    )
    if (dependencies.config.NODE_ENV === 'production') {
      if (request.host.toLowerCase() !== publicOrigin.host.toLowerCase()) {
        return reply.status(421).send({
          error: { code: 'HOST_NOT_ALLOWED', message: 'Адрес запроса не разрешён' },
        })
      }
      if (publicOrigin.protocol === 'https:' && request.protocol !== 'https') {
        return reply.status(400).send({
          error: { code: 'HTTPS_REQUIRED', message: 'Требуется защищённое соединение' },
        })
      }
    }
    const operationRef = requestOperationRef(request)
    if (operationRef) reply.header('X-Kabanda-Operation-Ref', operationRef)
    if (
      isApiPath(request.url) &&
      !safeMethods.has(request.method) &&
      request.headers.origin !== dependencies.config.APP_ORIGIN
    ) {
      return reply.status(403).send({
        error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Источник запроса не разрешён' },
      })
    }
  })

  app.addHook('preSerialization', async (request, reply, payload) => {
    if (
      reply.statusCode < 400 ||
      !payload ||
      typeof payload !== 'object' ||
      !('error' in payload) ||
      !payload.error ||
      typeof payload.error !== 'object'
    ) return payload
    return {
      ...payload,
      error: {
        ...payload.error,
        errorId: request.id,
        ...(requestOperationRef(request) ? { operationRef: requestOperationRef(request) } : {}),
      },
    }
  })

  app.addHook('onResponse', async (request, reply) => {
    if (dependencies.config.NODE_ENV === 'test') return
    const clientBuild = boundedHeader(request.headers['x-kabanda-client-build'], buildIdentifierSchema)
    const diagnosticSessionId = dependencies.config.ALPHA_DIAGNOSTICS_ENABLED
      ? boundedHeader(request.headers['x-kabanda-diagnostic-session'], z.uuid())
      : undefined
    request.log.info(
      {
        requestId: request.id,
        apiBuild: dependencies.config.API_BUILD_ID,
        clientBuild,
        diagnosticSessionId,
        operationRef: requestOperationRef(request),
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        outcome: reply.statusCode >= 500 ? 'server_error' : reply.statusCode >= 400 ? 'client_error' : 'success',
        statusCode: reply.statusCode,
        latencyBucket: latencyBucket(reply.elapsedTime),
      },
      'request completed',
    )
  })

  app.setErrorHandler((error, request, reply) => {
    if ((error as { statusCode?: number }).statusCode === 413) {
      return reply.status(413).send({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Запрос слишком большой' },
      })
    }
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
    const databaseError = error as { code?: string; constraint?: string }
    request.log.error(
      {
        requestId: request.id,
        operationRef: requestOperationRef(request),
        name: error instanceof Error ? error.name : 'UnknownError',
        code: databaseError.code,
        constraint: databaseError.constraint,
      },
      'request failed',
    )
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
    '/api/diagnostics/signals',
    {
      bodyLimit: 4 * 1024,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!dependencies.config.ALPHA_DIAGNOSTICS_ENABLED) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Ресурс не найден' },
        })
      }
      const token = request.cookies[dependencies.config.cookieName]
      const user = token ? await dependencies.auth.getUser(token) : null
      if (!user) return reply.status(401).send(unauthorized())
      const signal = alphaDiagnosticSignalSchema.parse(request.body)
      const headerSession = boundedHeader(request.headers['x-kabanda-diagnostic-session'], z.uuid())
      const headerBuild = boundedHeader(request.headers['x-kabanda-client-build'], buildIdentifierSchema)
      if (headerSession !== signal.diagnosticSessionId || headerBuild !== signal.clientBuild) {
        return reply.status(400).send({
          error: { code: 'DIAGNOSTIC_CONTEXT_MISMATCH', message: 'Диагностический контекст не совпадает' },
        })
      }
      dependencies.onDiagnosticSignal?.(signal)
      request.log.warn({ signal }, 'closed alpha diagnostic signal')
      return reply.status(202).send({ accepted: true })
    },
  )

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

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = passwordLoginSchema.parse(request.body)
      const session = await dependencies.auth.loginWithPassword(input.username, input.password)
      if (!session) return reply.status(401).send(unauthorized())
      reply.setCookie(dependencies.config.cookieName, session.rawToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: dependencies.config.secureCookies,
        path: '/',
        maxAge: dependencies.config.SESSION_TTL_DAYS * 24 * 60 * 60,
      })
      return { user: session.user }
    },
  )

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

  app.setNotFoundHandler((request, reply) => {
    const acceptsHtml = request.headers.accept
      ?.split(',')
      .some((mediaType) => mediaType.trim().split(';')[0] === 'text/html')
    if (
      dependencies.config.PWA_DIST_DIR &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !isApiPath(request.url) &&
      acceptsHtml
    ) {
      reply.header('Cache-Control', 'no-store')
      return reply.sendFile('index.html')
    }
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Ресурс не найден' },
    })
  })

  return app
}
