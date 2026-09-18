import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AuthService } from './auth.js'
import type { ApiConfig } from './config.js'
import type { ProgressReadService } from './progress-reads.js'

const paramsSchema = z.object({ id: z.uuid() })
const historySchema = z.object({
  filter: z.enum(['all', 'mine']).default('all'),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  cursor: z.string().min(1).max(768).optional(),
}).strict()
const pointsSchema = z.object({
  category: z.enum(['stores', 'attractions']),
  pointIds: z.string().max(3700).transform(value => value ? value.split(',') : [])
    .pipe(z.array(z.uuid()).max(100)).optional(),
}).strict()

export async function registerProgressReadRoutes(app: FastifyInstance, dependencies: {
  auth: AuthService; config: ApiConfig; progressReads: ProgressReadService;
}) {
  const options = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }
  app.get('/api/kabandas/:id/progress/raids/history', options, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const token = request.cookies[dependencies.config.cookieName]
    const user = token ? await dependencies.auth.getUser(token) : null
    if (!user) return reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Нужно войти в Кабанду' } })
    const { id } = paramsSchema.parse(request.params)
    return dependencies.progressReads.history(user.id, id, historySchema.parse(request.query))
  })
  app.get('/api/kabandas/:id/progress/points', options, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const token = request.cookies[dependencies.config.cookieName]
    const user = token ? await dependencies.auth.getUser(token) : null
    if (!user) return reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Нужно войти в Кабанду' } })
    const { id } = paramsSchema.parse(request.params)
    return dependencies.progressReads.points(user.id, id, pointsSchema.parse(request.query))
  })
}
