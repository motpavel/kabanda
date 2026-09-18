import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'
import { historyPageQuerySchema, pointProgressQuerySchema } from '@kabanda/contracts/exploration'
import type { AuthService } from './auth.js'
import type { ApiConfig } from './config.js'
import { readHistoryPage, readPointProgress } from './exploration-reads.js'

/** Registered by the composition root before the app is listened to or injected
 * by the relay. Existing /raids/history remains unchanged for old PWAs. */
export async function registerExplorationRoutes(app: FastifyInstance, dependencies: {
  auth: AuthService; config: ApiConfig; database: Pick<Pool, 'query'>
}) {
  app.get('/api/kabandas/:kabandaId/raids/history/page', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const token = request.cookies[dependencies.config.cookieName]
    const user = token ? await dependencies.auth.getUser(token) : null
    if (!user) return reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' } })
    const { kabandaId } = z.object({ kabandaId: z.uuid() }).parse(request.params)
    const query = historyPageQuerySchema.parse(request.query)
    return readHistoryPage(dependencies.database, user.id, kabandaId, query)
  })
  app.get('/api/kabandas/:kabandaId/points/progress', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const token = request.cookies[dependencies.config.cookieName]
    const user = token ? await dependencies.auth.getUser(token) : null
    if (!user) return reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' } })
    const { kabandaId } = z.object({ kabandaId: z.uuid() }).parse(request.params)
    const query = pointProgressQuerySchema.parse(request.query)
    return readPointProgress(dependencies.database, user.id, kabandaId, query)
  })
}
