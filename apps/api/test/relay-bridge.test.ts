import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  createRelayKey, encryptRelayBytes, openRelayResponse, sealRelayRequest,
  type RelayRequestPayload, type RelayResponsePayload, type User,
} from '@kabanda/contracts'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import type { AuthService } from '../src/auth.js'
import type { KabandaService } from '../src/kabandas.js'
import { RaidError, type RaidService } from '../src/raids.js'
import { buildRelayBridge, type RelayBlobStore } from '../src/relay-bridge.js'

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const origin = 'https://kabanda.website.yandexcloud.net'
const user: User = {
  id: '7484a9f8-11dd-45bd-9740-44b52413fa6b', email: null, username: 'pavel',
  identityKind: 'invite', displayName: 'Павел', avatarUrl: null,
}
const rawToken = 'private-session-token-not-for-the-browser'
const raidId = '81297402-898c-48d6-bc78-c74b6b38205c'
const mediaId = '4489d5f6-3850-46d9-a9b7-f34e9d6835d9'
const apps: FastifyInstance[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })

function jsonBody(value: unknown) { return { base64: Buffer.from(JSON.stringify(value)).toString('base64') } }
function request(path: string, extra: Partial<Extract<RelayRequestPayload, { operation: 'request' }>> = {}): RelayRequestPayload {
  return { operation: 'request', method: 'GET', path, headers: {}, ...extra }
}
function login(username = 'pavel', password = 'long-password'): RelayRequestPayload {
  return request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonBody({ username, password }) })
}
function apiResponse(value: RelayResponsePayload) {
  if (value.operation !== 'response') throw new Error('Expected API response')
  return value
}
function sessionFrom(value: RelayResponsePayload): string {
  const session = apiResponse(value).session
  if (!session) throw new Error('Expected relay session')
  return session
}

async function fixture(options: {
  auth?: Partial<AuthService>; kabandas?: Partial<KabandaService>; raids?: Partial<RaidService>;
  now?: () => number; deadlineMs?: number;
} = {}) {
  const sessions = new Set([rawToken])
  const auth: AuthService = {
    requestMagicLink: vi.fn().mockResolvedValue(undefined),
    verifyMagicLink: vi.fn().mockResolvedValue({ rawToken, returnTo: '/home', user }),
    loginWithPassword: vi.fn(async (_username, password) => password === 'long-password' ? { rawToken, returnTo: '/home', user } : null),
    getUser: vi.fn(async (token) => sessions.has(token) ? user : null),
    updateProfile: vi.fn().mockResolvedValue(user),
    revokeSession: vi.fn(async (token) => { sessions.delete(token) }),
    ...options.auth,
  }
  const kabandas = {
    listKabandas: vi.fn().mockResolvedValue([]),
    ...options.kabandas,
  } as unknown as KabandaService
  const config = loadConfig({
    NODE_ENV: 'production', APP_ORIGIN: origin, TRUST_PROXY_ADDRESS: '127.0.0.1',
    ALPHA_ACCESS_MODE: 'enforced', ALPHA_ACCESS_SECRET: 'test-alpha-secret-32-characters-long',
    MEDIA_CAPABILITY_SECRET: 'test-media-secret-32-characters-long', SESSION_TTL_DAYS: '1',
  })
  const app = await buildApp({
    auth, kabandas, config, readiness: async () => {},
    ...(options.raids ? { raids: options.raids as RaidService } : {}),
  })
  const responseObjects = new Map<string, Uint8Array>()
  const uploads = new Map<string, { owner: string; bytes?: Uint8Array; id: string }>()
  const blobs: RelayBlobStore = {
    prepareUpload: vi.fn(async ({ id, owner }) => {
      const ticket = randomUUID()
      uploads.set(ticket, { id, owner })
      return { url: `https://storage.yandexcloud.net/test/upload/${ticket}`, ticket }
    }),
    readUpload: vi.fn(async ({ ticket, id, owner }) => {
      const item = uploads.get(ticket)
      if (!item?.bytes || item.owner !== owner || item.id !== id) throw new Error('Invalid upload ticket')
      return item.bytes
    }),
    publishResponse: vi.fn(async ({ id, body }) => {
      const url = `https://storage.yandexcloud.net/test/responses/${id}`
      responseObjects.set(url, body)
      return url
    }),
  }
  const bridge = await buildRelayBridge({
    app, publicOrigin: origin, cookieName: config.cookieName,
    pendingInviteCookieName: '__Host-kabanda_pending_invite',
    sessionSecret: 'test-cookie-jar-secret-with-at-least-32-characters',
    privateKeyPkcs8Pem: keys.privateKey, blobs,
    ...(options.now ? { now: options.now } : {}),
    ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
  })
  apps.push(bridge, app)
  async function send(payload: RelayRequestPayload, id = randomUUID(), suppliedKey?: CryptoKey) {
    const { key, envelope } = await sealRelayRequest(keys.publicKey, id, payload, suppliedKey)
    const outer = await bridge.inject({ method: 'POST', url: '/relay/v1/request', payload: envelope })
    expect(outer.statusCode).toBe(200)
    expect(outer.headers['set-cookie']).toBeUndefined()
    let cipher = outer.json()
    if ('objectUrl' in cipher) cipher = JSON.parse(Buffer.from(responseObjects.get(cipher.objectUrl)!).toString('utf8'))
    const response = await openRelayResponse(key, id, cipher)
    return { outer, response, envelope, key, id }
  }
  return { app, bridge, auth, blobs, uploads, responseObjects, send }
}

describe('private encrypted storage relay bridge', () => {
  it('keeps existing production host/origin/HTTPS checks while forwarding login, profile and logout', async () => {
    const f = await fixture()
    const loginReply = await f.send(login())
    const session = sessionFrom(loginReply.response)
    expect(loginReply.outer.body).not.toContain(rawToken)
    expect(JSON.stringify(loginReply.response)).not.toContain(rawToken)
    expect(apiResponse(loginReply.response).headers['set-cookie']).toBeUndefined()
    const me = apiResponse((await f.send(request('/api/me', { session }))).response)
    expect(me.status).toBe(200)
    expect(JSON.parse(Buffer.from(me.bodyBase64, 'base64').toString()).user.id).toBe(user.id)
    expect(f.auth.getUser).toHaveBeenCalledWith(rawToken)
    const logout = apiResponse((await f.send(request('/api/auth/logout', { method: 'POST', session }))).response)
    expect(logout.status).toBe(204)
    expect(logout.session).toBeNull()
    expect(f.auth.revokeSession).toHaveBeenCalledWith(rawToken)
    expect(apiResponse((await f.send(request('/api/me', { session }))).response).status).toBe(401)
    const invalidDirect = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'pavel', password: 'long-password' } })
    expect(invalidDirect.statusCode).toBe(421)
  })

  it('keeps the magic-link verification session private', async () => {
    const f = await fixture()
    const verified = apiResponse((await f.send(request('/api/auth/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonBody({ token: 'x'.repeat(32) }),
    }))).response)
    expect(verified.status).toBe(200)
    expect(sessionFrom(verified)).not.toContain(rawToken)
    expect(Buffer.from(verified.bodyBase64, 'base64').toString()).toBe('{"returnTo":"/home"}')
  })

  it('preserves a pending invitation and processes session-set plus invitation-clear in one response', async () => {
    const continuation = 'c'.repeat(32)
    const invite = { continuation, accepted: false, kabanda: { id: raidId }, requiresAuth: true }
    const previewContinuation = vi.fn().mockResolvedValue(invite)
    const f = await fixture({ kabandas: {
      previewInvite: vi.fn().mockResolvedValue(invite), previewContinuation,
      acceptInviteWithCredentials: vi.fn().mockResolvedValue({ rawSessionToken: rawToken, kabanda: { id: raidId } }),
    } })
    const preview = await f.send(request('/api/invites/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonBody({ token: 't'.repeat(32) }),
    }))
    const pending = sessionFrom(preview.response)
    await f.send(request('/api/invites/preview', {
      method: 'POST', session: pending, headers: { 'content-type': 'application/json' }, body: jsonBody({ pending: true }),
    }))
    expect(previewContinuation).toHaveBeenCalledWith(continuation, true, undefined)
    const accepted = await f.send(request('/api/invites/accept', {
      method: 'POST', session: pending, headers: { 'content-type': 'application/json', 'idempotency-key': 'invite-register-123' },
      body: jsonBody({ continuation, username: 'pavel', password: 'long-password' }),
    }))
    const registeredSession = sessionFrom(accepted.response)
    expect(apiResponse((await f.send(request('/api/me', { session: registeredSession }))).response).status).toBe(200)
    previewContinuation.mockClear()
    const pendingAfterRegistration = apiResponse((await f.send(request('/api/invites/preview', {
      method: 'POST', session: registeredSession, headers: { 'content-type': 'application/json' }, body: jsonBody({ pending: true }),
    }))).response)
    expect(pendingAfterRegistration.status).toBe(400)
    expect(previewContinuation).not.toHaveBeenCalled()
  })

  it('expires pending invitations separately without extending cookies on reads', async () => {
    let current = Date.now()
    const previewContinuation = vi.fn()
    const f = await fixture({ now: () => current, kabandas: {
      previewInvite: vi.fn().mockResolvedValue({ continuation: 'c'.repeat(32), accepted: false }), previewContinuation,
    } })
    const pending = sessionFrom((await f.send(request('/api/invites/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonBody({ token: 't'.repeat(32) }),
    }))).response)
    current += 30 * 60 * 1000 + 1
    expect(apiResponse((await f.send(request('/api/invites/preview', {
      method: 'POST', session: pending, headers: { 'content-type': 'application/json' }, body: jsonBody({ pending: true }),
    }))).response).status).toBe(400)
    expect(previewContinuation).not.toHaveBeenCalled()
    const session = sessionFrom((await f.send(login())).response)
    const me = apiResponse((await f.send(request('/api/me', { session }))).response)
    expect(me.session).toBeUndefined()
    current += 24 * 60 * 60 * 1000 + 1
    expect(apiResponse((await f.send(request('/api/me', { session }))).response).status).toBe(401)
  })

  it('rejects a forged opaque session without forwarding it as an API token', async () => {
    const f = await fixture()
    const response = apiResponse((await f.send(request('/api/me', { session: 'v1.a.b.c' }))).response)
    expect(response.status).toBe(401)
    expect(response.session).toBeNull()
    expect(f.auth.getUser).not.toHaveBeenCalled()
  })

  it('rejects non-API paths, traversal and request header injection before calling the API', async () => {
    const f = await fixture()
    for (const path of [
      'https://evil.example/api/me', '//evil.example/api/me', '/assets/file', '/api/../health',
      '/api/%2e%2e/health', '/api/%252e%252e/health', '/api//me', '/api/\\evil', '/api/me#fragment', '/api/%3f/health',
    ]) {
      expect(apiResponse((await f.send(request(path))).response).status, path).toBe(400)
    }
    for (const name of ['cookie', 'Authorization', 'Host', 'origin', 'x-forwarded-for', 'x-forwarded-proto', 'X-Relay-User']) {
      expect(apiResponse((await f.send(request('/api/me', { headers: { [name]: rawToken } }))).response).status, name).toBe(400)
    }
    expect(apiResponse((await f.send(request('/api/me', { headers: { accept: 'application/json\r\nCookie: forged' } }))).response).status).toBe(400)
    expect(f.auth.getUser).not.toHaveBeenCalled()
  })

  it('preserves API rate limits per account instead of grouping everyone under the relay IP', async () => {
    const f = await fixture()
    for (let index = 0; index < 5; index += 1) expect(apiResponse((await f.send(login('pavel', 'wrong-password'))).response).status).toBe(401)
    const limited = apiResponse((await f.send(login('PAVEL', 'wrong-password'))).response)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    expect(apiResponse((await f.send(login('anya'))).response).status).toBe(200)
  })

  it('does not run the same encrypted mutation twice and rejects reuse of its id for another envelope', async () => {
    const f = await fixture()
    const first = await f.send(login())
    const retried = await f.bridge.inject({ method: 'POST', url: '/relay/v1/request', payload: first.envelope })
    expect(retried.body).toBe(first.outer.body)
    expect(f.auth.loginWithPassword).toHaveBeenCalledTimes(1)
    const changed = await sealRelayRequest(keys.publicKey, first.id, login('anya'))
    const conflict = await f.bridge.inject({ method: 'POST', url: '/relay/v1/request', payload: changed.envelope })
    expect(conflict.statusCode).toBe(502)
    expect(f.auth.loginWithPassword).toHaveBeenCalledTimes(1)
  })

  it('does not reissue an expired session from the retry cache', async () => {
    let current = Date.now()
    const f = await fixture({ now: () => current })
    const session = sessionFrom((await f.send(login())).response)
    current += 24 * 60 * 60 * 1000 - 10_000
    const first = await f.send(request('/api/me', { session }))
    expect(apiResponse(first.response).status).toBe(200)
    current += 10_001
    const retried = await f.bridge.inject({ method: 'POST', url: '/relay/v1/request', payload: first.envelope })
    expect(apiResponse(await openRelayResponse(first.key, first.id, retried.json())).status).toBe(401)
  })

  it('does not repeat a committed invitation when publishing its oversized encrypted reply fails', async () => {
    const createInvite = vi.fn().mockResolvedValue({ id: randomUUID(), token: 'large-invite-response-'.repeat(8_000) })
    const f = await fixture({ kabandas: { createInvite } })
    const session = sessionFrom((await f.send(login())).response)
    vi.mocked(f.blobs.publishResponse).mockRejectedValue(new Error('Object Storage unavailable after API commit'))
    const { envelope } = await sealRelayRequest(keys.publicKey, randomUUID(), request(`/api/kabandas/${raidId}/invites`, {
      method: 'POST', session, headers: { 'content-type': 'application/json' }, body: jsonBody({ expiresInHours: 24 }),
    }))
    const first = await f.bridge.inject({ method: 'POST', url: '/relay/v1/request', payload: envelope })
    expect(first.statusCode).toBe(502)
    expect(createInvite).toHaveBeenCalledOnce()
    const retried = await f.bridge.inject({ method: 'POST', url: '/relay/v1/request', payload: envelope })
    expect(retried.statusCode).toBe(502)
    expect(retried.body).toBe(first.body)
    expect(createInvite).toHaveBeenCalledOnce()
    expect(f.blobs.publishResponse).toHaveBeenCalledOnce()
  })

  it('returns encrypted media only after the original API authorizes access and stores oversized responses encrypted', async () => {
    const image = Buffer.alloc(100_000, 0x9b)
    const readMedia = vi.fn().mockResolvedValue({ contentType: 'image/jpeg', bytes: image })
    const f = await fixture({ raids: { readMedia } })
    const path = `/api/raids/${raidId}/media/${mediaId}/content`
    expect(apiResponse((await f.send(request(path))).response).status).toBe(401)
    expect(readMedia).not.toHaveBeenCalled()
    const session = sessionFrom((await f.send(login())).response)
    const result = await f.send(request(path, { session }))
    expect(result.outer.json()).toHaveProperty('objectUrl')
    expect(Buffer.from(apiResponse(result.response).bodyBase64, 'base64')).toEqual(image)
    expect(readMedia).toHaveBeenCalledWith(user.id, raidId, mediaId)
    expect(f.blobs.publishResponse).toHaveBeenCalledOnce()
    const stored = [...f.responseObjects.values()][0]!
    expect(Buffer.from(stored).toString()).not.toContain(image.toString('base64').slice(0, 100))
    readMedia.mockRejectedValue(new RaidError('FORBIDDEN', 403, 'Нет доступа'))
    expect(apiResponse((await f.send(request(path, { session }))).response).status).toBe(403)
  })

  it('requires an authenticated owner for upload tickets and forwards decrypted bytes with existing capability checks', async () => {
    const uploadMedia = vi.fn().mockResolvedValue({ accepted: true })
    const f = await fixture({ raids: { uploadMedia } })
    const targetId = randomUUID()
    const content = Buffer.alloc(80_000, 0x7f)
    const key = await createRelayKey()
    const encrypted = await encryptRelayBytes(key, targetId, 'body', content)
    expect(apiResponse((await f.send({ operation: 'upload', targetId, byteLength: encrypted.byteLength })).response).status).toBe(401)
    expect(f.blobs.prepareUpload).not.toHaveBeenCalled()
    const session = sessionFrom((await f.send(login())).response)
    const prepared = (await f.send({ operation: 'upload', targetId, byteLength: encrypted.byteLength, session })).response
    if (prepared.operation !== 'upload') throw new Error('Expected upload')
    f.uploads.get(prepared.ticket)!.bytes = encrypted
    const response = apiResponse((await f.send(request(`/api/raids/${raidId}/media/intents/${mediaId}/content`, {
      method: 'PUT', session, body: { uploadTicket: prepared.ticket },
      headers: { 'content-type': 'image/jpeg', 'x-upload-capability': 'c'.repeat(32), 'x-content-sha256': 'a'.repeat(64) },
    }), targetId, key)).response)
    expect(response.status).toBe(200)
    expect(f.blobs.prepareUpload).toHaveBeenCalledWith({ id: targetId, byteLength: encrypted.byteLength, owner: user.id })
    expect(f.blobs.readUpload).toHaveBeenCalledWith({ id: targetId, ticket: prepared.ticket, owner: user.id })
    expect(uploadMedia).toHaveBeenCalledWith(user.id, raidId, mediaId, 'c'.repeat(32), 'a'.repeat(64), content)
  })

  it('reports transport timeout without running a retry concurrently with a pending mutation', async () => {
    let complete!: () => void
    const pending = new Promise<void>((resolve) => { complete = resolve })
    const loginWithPassword = vi.fn(async () => { await pending; return { rawToken, returnTo: '/home', user } })
    // Allow RSA work on a small shared VM to finish inside a request deadline.
    // The unresolved promise, rather than CPU speed, forces the timeout.
    const f = await fixture({ deadlineMs: 250, auth: { loginWithPassword } })
    const id = randomUUID()
    const { envelope, key } = await sealRelayRequest(keys.publicKey, id, login())
    const first = await f.bridge.inject({ method: 'POST', url: '/relay/v1/request', payload: envelope })
    expect(first.statusCode).toBe(503)
    const stillPending = await f.bridge.inject({ method: 'POST', url: '/relay/v1/request', payload: envelope })
    expect(stillPending.statusCode).toBe(503)
    expect(loginWithPassword).toHaveBeenCalledTimes(1)
    complete()
    const second = await f.bridge.inject({ method: 'POST', url: '/relay/v1/request', payload: envelope })
    expect(second.statusCode).toBe(200)
    expect(apiResponse(await openRelayResponse(key, id, second.json())).status).toBe(200)
    expect(loginWithPassword).toHaveBeenCalledTimes(1)
  })

  it('does not turn a database outage during upload authorization into a logout', async () => {
    const f = await fixture()
    const session = sessionFrom((await f.send(login())).response)
    vi.mocked(f.auth.getUser).mockRejectedValue(new Error('Database temporarily unavailable'))
    const { envelope } = await sealRelayRequest(keys.publicKey, randomUUID(), {
      operation: 'upload', targetId: randomUUID(), byteLength: 100, session,
    })
    const response = await f.bridge.inject({ method: 'POST', url: '/relay/v1/request', payload: envelope })
    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: 'RELAY_UNAVAILABLE' })
    expect(f.blobs.prepareUpload).not.toHaveBeenCalled()
  })

  it('does not expose decryption diagnostics or credentials for an invalid envelope', async () => {
    const f = await fixture()
    const { envelope } = await sealRelayRequest(keys.publicKey, randomUUID(), login())
    envelope.id = randomUUID()
    const response = await f.bridge.inject({ method: 'POST', url: '/relay/v1/request', payload: envelope })
    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: 'RELAY_UNAVAILABLE' })
    expect(f.auth.loginWithPassword).not.toHaveBeenCalled()
  })

  it('runs the production Node health probe against real local API and encrypted facade listeners', async () => {
    const f = await fixture()
    const apiAddress = await f.app.listen({ host: '127.0.0.1', port: 0 })
    const relayAddress = await f.bridge.listen({ host: '127.0.0.1', port: 0 })
    const folder = await mkdtemp(join(tmpdir(), 'kabanda-relay-probe-'))
    const privateKeyFile = join(folder, 'synthetic-private-key.pem')
    await writeFile(privateKeyFile, keys.privateKey, { mode: 0o400 })
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL('../../../infra/yandex/probe_runtime.mjs', import.meta.url)),
      ], {
        env: {
          ...process.env, APP_ORIGIN: origin,
          API_PORT: new URL(apiAddress).port, RELAY_PORT: new URL(relayAddress).port,
          RELAY_PRIVATE_KEY_FILE: privateKeyFile, API_BUILD_ID: 'probe-test',
        },
        timeout: 15_000,
      })
      const result = JSON.parse(stdout)
      expect(result.apiReady).toBe(true)
      expect(result.encryptedRelayRoundTrip).toBe(true)
      expect(result.publicKeySpkiSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(result.apiBuild).toBe('probe-test')
      expect(stdout).not.toContain('PRIVATE KEY')
      expect(f.auth.loginWithPassword).not.toHaveBeenCalled()
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
