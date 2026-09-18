import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { AuthService } from '../src/auth.js'
import type { KabandaService } from '../src/kabandas.js'
import type { RaidService } from '../src/raids.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { readHistoryPage, readPointProgress } from '../src/exploration-reads.js'

vi.mock('../src/exploration-reads.js', () => ({ readHistoryPage: vi.fn(), readPointProgress: vi.fn() }))
const viewer = '11111111-1111-4111-8111-111111111111'
const team = '22222222-2222-4222-8222-222222222222'
const apps: FastifyInstance[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.clearAllMocks() })
async function fixture() {
  const getUser = vi.fn().mockResolvedValue({ id: viewer })
  const legacy = vi.fn().mockResolvedValue({ raids: [], nextCursor: null })
  const config = loadConfig({ NODE_ENV: 'test' })
  const database = { query: vi.fn() } as unknown as Pick<Pool, 'query'>
  const app = await buildApp({
    auth: { getUser } as unknown as AuthService,
    kabandas: {} as KabandaService,
    raids: { listHistory: legacy } as unknown as RaidService,
    database, config, readiness: async () => undefined,
  })
  apps.push(app)
  return { app, legacy, database, cookie: { [config.cookieName]: 'synthetic-session' } }
}

describe('exploration route registration and validation', () => {
  it('requires a current authenticated user for both read routes', async () => {
    const { app } = await fixture()
    for (const path of ['raids/history/page', 'points/progress?category=stores']) {
      const response = await app.inject({ url: `/api/kabandas/${team}/${path}` })
      expect(response.statusCode).toBe(401)
      expect(response.headers['cache-control']).toBe('private, no-store')
    }
    expect(readHistoryPage).not.toHaveBeenCalled()
    expect(readPointProgress).not.toHaveBeenCalled()
  })

  it('passes the authenticated identity and validated mine scope, leaving old clients unchanged', async () => {
    const { app, database, cookie, legacy } = await fixture()
    vi.mocked(readHistoryPage).mockResolvedValue({ schemaVersion: 2, scope: 'mine', raids: [], nextCursor: null })
    const response = await app.inject({ url: `/api/kabandas/${team}/raids/history/page?scope=mine&limit=12`, cookies: cookie })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ scope: 'mine', schemaVersion: 2 })
    expect(readHistoryPage).toHaveBeenCalledWith(database, viewer, team, { scope: 'mine', limit: 12 })
    const old = await app.inject({ url: `/api/kabandas/${team}/raids/history?limit=12`, cookies: cookie })
    expect(old.statusCode).toBe(200)
    expect(old.json()).toEqual({ raids: [], nextCursor: null })
    expect(legacy).toHaveBeenCalled()
  })

  it('bounds history pages and point categories before database reads', async () => {
    const { app, cookie } = await fixture()
    for (const path of ['raids/history/page?limit=5000', 'raids/history/page?scope=other', 'points/progress?category=all', 'points/progress?category=attractions']) {
      expect((await app.inject({ url: `/api/kabandas/${team}/${path}`, cookies: cookie })).statusCode).toBe(400)
    }
    expect(readHistoryPage).not.toHaveBeenCalled()
    expect(readPointProgress).not.toHaveBeenCalled()
  })
})
