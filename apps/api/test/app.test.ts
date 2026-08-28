import type { User } from '@kabanda/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildMagicLinkVerificationUrl,
  type AuthService,
  type VerifiedSession,
} from '../src/auth.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import type { KabandaService } from '../src/kabandas.js'

const user: User = {
  id: '7484a9f8-11dd-45bd-9740-44b52413fa6b',
  email: 'pavel@example.com',
  displayName: 'Павел',
  avatarUrl: null,
}

const testOrigin = 'http://localhost:5173'

function createAuth(overrides: Partial<AuthService> = {}): AuthService {
  return {
    requestMagicLink: vi.fn().mockResolvedValue(undefined),
    verifyMagicLink: vi.fn().mockResolvedValue(null),
    getUser: vi.fn().mockResolvedValue(null),
    updateProfile: vi.fn().mockResolvedValue(null),
    revokeSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function createKabandas(overrides: Partial<KabandaService> = {}): KabandaService {
  return {
    listKabandas: vi.fn().mockResolvedValue([]),
    createKabanda: vi.fn(),
    listMembers: vi.fn().mockResolvedValue([]),
    leaveKabanda: vi.fn(),
    removeMember: vi.fn(),
    createInvite: vi.fn(),
    revokeInvite: vi.fn(),
    previewInvite: vi.fn(),
    previewContinuation: vi.fn(),
    acceptInvite: vi.fn(),
    listPoints: vi.fn().mockResolvedValue({ points: [], nextCursor: null }),
    ...overrides,
  }
}

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

async function createTestApp(auth: AuthService, kabandas = createKabandas()) {
  const app = await buildApp({
    auth,
    kabandas,
    config: loadConfig({ NODE_ENV: 'test' }),
    readiness: vi.fn().mockResolvedValue(undefined),
  })
  apps.push(app)
  return app
}

describe('API foundation', () => {
  it('reports liveness', async () => {
    const app = await createTestApp(createAuth())
    const response = await app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', service: 'kabanda-api' })
  })

  it('accepts a valid magic-link request without exposing a token', async () => {
    const auth = createAuth()
    const app = await createTestApp(auth)
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/request-link',
      headers: { origin: testOrigin },
      payload: { email: 'pavel@example.com', returnTo: '/lobby/raid-1' },
    })
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: true })
    expect(auth.requestMagicLink).toHaveBeenCalledWith('pavel@example.com', '/lobby/raid-1')
  })

  it('keeps the raw magic token in a fragment that is not sent to the server', () => {
    const rawToken = 'x'.repeat(32)
    const url = new URL(buildMagicLinkVerificationUrl(testOrigin, rawToken, '/kabanda/'))
    expect(url.pathname).toBe('/kabanda/auth/verify')
    expect(url.search).toBe('')
    expect(new URLSearchParams(url.hash.slice(1)).get('token')).toBe(rawToken)
  })

  it('does not consume a magic link through GET or mail prefetch', async () => {
    const auth = createAuth()
    const app = await createTestApp(auth)
    const response = await app.inject({
      method: 'GET',
      url: `/api/auth/verify?token=${'x'.repeat(32)}`,
    })
    expect(response.statusCode).toBe(404)
    expect(auth.verifyMagicLink).not.toHaveBeenCalled()
  })

  it('sets an HttpOnly cookie after an explicit same-origin exchange', async () => {
    const verified: VerifiedSession = { rawToken: 'raw-session-token', returnTo: '/home', user }
    const app = await createTestApp(
      createAuth({ verifyMagicLink: vi.fn().mockResolvedValue(verified) }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: { origin: testOrigin },
      payload: { token: 'x'.repeat(32) },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['set-cookie']).toContain('HttpOnly')
    expect(response.json()).toEqual({ returnTo: '/home' })
  })

  it('allows only one winner for two concurrent exchanges', async () => {
    const verified: VerifiedSession = { rawToken: 'raw-session-token', returnTo: '/home', user }
    const verifyMagicLink = vi.fn().mockResolvedValueOnce(verified).mockResolvedValueOnce(null)
    const app = await createTestApp(createAuth({ verifyMagicLink }))
    const request = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/verify',
        headers: { origin: testOrigin },
        payload: { token: 'x'.repeat(32) },
      })

    const responses = await Promise.all([request(), request()])
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 400])
    expect(verifyMagicLink).toHaveBeenCalledTimes(2)
  })

  it('rejects unsafe API requests without the configured origin', async () => {
    const auth = createAuth()
    const app = await createTestApp(auth)
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('ORIGIN_NOT_ALLOWED')
    expect(auth.revokeSession).not.toHaveBeenCalled()
  })

  it('does not expose the profile without a valid session', async () => {
    const app = await createTestApp(createAuth())
    const response = await app.inject({ method: 'GET', url: '/api/me' })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('AUTH_REQUIRED')
  })

  it('creates a Kabanda with a client idempotency key', async () => {
    const createKabanda = vi.fn().mockResolvedValue({
      id: '81297402-898c-48d6-bc78-c74b6b38205c',
      name: 'Ночные кабаны',
      avatar: '🌙',
      role: 'owner',
      memberCount: 1,
      pointsCollectionId: null,
    })
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas({ createKabanda }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/kabandas',
      headers: { origin: testOrigin, cookie: 'kabanda_session=session', 'idempotency-key': 'create-1234' },
      payload: { name: 'Ночные кабаны', avatar: '🌙' },
    })
    expect(response.statusCode).toBe(201)
    expect(createKabanda).toHaveBeenCalledWith(user.id, 'Ночные кабаны', '🌙', 'create-1234')
  })

  it('never places a raw invite token in a redirect', async () => {
    const previewInvite = vi.fn().mockResolvedValue({
      continuation: 'continuation-secret',
      kabanda: {
        id: '81297402-898c-48d6-bc78-c74b6b38205c',
        name: 'Ночные кабаны',
        avatar: '🌙',
        role: 'member',
        memberCount: 1,
        pointsCollectionId: null,
      },
      inviterName: 'Павел',
      expiresAt: new Date().toISOString(),
      requiresAuth: true,
      accepted: false,
    })
    const app = await createTestApp(createAuth(), createKabandas({ previewInvite }))
    const response = await app.inject({
      method: 'POST',
      url: '/api/invites/preview',
      headers: { origin: testOrigin },
      payload: { token: 'x'.repeat(32) },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers.location).toBeUndefined()
    expect(response.json().invite.continuation).toBe('continuation-secret')
    expect(response.headers['set-cookie']).toContain('kabanda_pending_invite=continuation-secret')
    expect(response.headers['set-cookie']).toContain('HttpOnly')
    expect(response.headers['set-cookie']).toContain('SameSite=Lax')
  })

  it('previews the same continuation after auth without issuing another one', async () => {
    const invite = {
      continuation: 'c'.repeat(32),
      kabanda: {
        id: '81297402-898c-48d6-bc78-c74b6b38205c',
        name: 'Ночные кабаны',
        avatar: '🌙',
        role: 'member' as const,
        memberCount: 1,
        pointsCollectionId: null,
      },
      inviterName: 'Павел',
      expiresAt: new Date().toISOString(),
      requiresAuth: false,
      accepted: false,
    }
    const previewContinuation = vi.fn().mockResolvedValue(invite)
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas({ previewContinuation }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/invites/preview',
      headers: { origin: testOrigin, cookie: 'kabanda_session=session' },
      payload: { continuation: invite.continuation },
    })
    expect(response.statusCode).toBe(200)
    expect(previewContinuation).toHaveBeenCalledWith(invite.continuation, false, user.id)
    expect(response.json().invite.continuation).toBe(invite.continuation)
  })

  it('recovers a pending invite from an HttpOnly cookie without a URL credential', async () => {
    const invite = {
      continuation: 'c'.repeat(32),
      kabanda: {
        id: '81297402-898c-48d6-bc78-c74b6b38205c',
        name: 'Ночные кабаны',
        avatar: '🌙',
        role: 'member' as const,
        memberCount: 1,
        pointsCollectionId: null,
      },
      inviterName: 'Павел',
      expiresAt: new Date().toISOString(),
      requiresAuth: false,
      accepted: false,
    }
    const previewContinuation = vi.fn().mockResolvedValue(invite)
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas({ previewContinuation }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/invites/preview',
      headers: {
        origin: testOrigin,
        cookie: `kabanda_session=session; kabanda_pending_invite=${invite.continuation}`,
      },
      payload: { pending: true },
    })
    expect(response.statusCode).toBe(200)
    expect(previewContinuation).toHaveBeenCalledWith(invite.continuation, false, user.id)
    expect(response.json().invite.kabanda.name).toBe('Ночные кабаны')
  })
})
