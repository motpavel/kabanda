import { reverseGeocodeQuerySchema } from '@kabanda/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthService } from './auth.js'
import type { ApiConfig } from './config.js'
import type { GeocodingService } from './geocoding.js'

type RouteDependencies = {
  auth: AuthService
  config: ApiConfig
  geocoding: GeocodingService
}

function authRequired(reply: FastifyReply) {
  return reply.status(401).send({
    error: { code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' },
  })
}

async function currentUser(request: FastifyRequest, dependencies: RouteDependencies) {
  const token = request.cookies[dependencies.config.cookieName]
  return token ? dependencies.auth.getUser(token) : null
}

export async function registerGeocodingRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): Promise<void> {
  app.get(
    '/api/geocoding/reverse',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const user = await currentUser(request, dependencies)
      if (!user) return authRequired(reply)
      const query = reverseGeocodeQuerySchema.parse(request.query)
      const result = await dependencies.geocoding.reverse(query.latitude, query.longitude)
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(result)
    },
  )
}
