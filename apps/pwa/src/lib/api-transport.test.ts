import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  decryptRelayBytes,
  openRelayRequest,
  relayBytesToBase64,
  sealRelayResponse,
  type RelayEnvelope,
  type RelayRequestPayload,
  type RelayResponsePayload,
} from '@kabanda/contracts/relay'
import { approvedRelayObjectUrl, createApiTransport, requestApi } from './api-transport'
import { ApiError } from './http'

let privateKey: string
let publicKey: string
beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' }, true, ['wrapKey', 'unwrapKey'])
  const pem = (kind: string, bytes: ArrayBuffer) => `-----BEGIN ${kind} KEY-----\n${relayBytesToBase64(new Uint8Array(bytes))}\n-----END ${kind} KEY-----`
  privateKey = pem('PRIVATE', await crypto.subtle.exportKey('pkcs8', keys.privateKey))
  publicKey = pem('PUBLIC', await crypto.subtle.exportKey('spki', keys.publicKey))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const origin = 'https://kabanda.website.yandexcloud.net'
const bucket = 'kabanda-private'
const objectUrl = `https://storage.yandexcloud.net/${bucket}/transport/v1/blobs/kabanda/synthetic/object?signature=test`
const storageKey = 'kabanda:relay-session:v1'
const config = () => ({ bootstrapUrl: 'https://storage.yandexcloud.net/kabanda/transport/v1/apps/kabanda/bootstrap.json', publicKey, storageBucket: bucket })
function memoryStorage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
function reply(status: number, body: unknown, session?: string | null): RelayResponsePayload {
  return { operation: 'response', status, headers: { 'content-type': 'application/json' },
    bodyBase64: relayBytesToBase64(new TextEncoder().encode(JSON.stringify(body))), ...(session === undefined ? {} : { session }) }
}
type Handler = (payload: RelayRequestPayload, envelope: RelayEnvelope, key: CryptoKey) => RelayResponsePayload | Promise<RelayResponsePayload>
function fakeRelay(handler: Handler) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body)) as RelayEnvelope
    const { payload, key } = await openRelayRequest(privateKey, envelope)
    return Response.json(await sealRelayResponse(key, envelope.id, await handler(payload, envelope, key)))
  })
}

describe('encrypted API transport', () => {
  it('keeps direct mode unchanged and does not initialize relay when disabled', async () => {
    vi.stubEnv('VITE_RELAY_BOOTSTRAP_URL', '')
    vi.stubEnv('VITE_RELAY_PUBLIC_KEY', '')
    const fetcher = vi.fn(async () => new Response('direct'))
    vi.stubGlobal('fetch', fetcher)
    const init = { method: 'POST', body: '{}', credentials: 'same-origin' as const }
    expect(await (await requestApi('/api/auth/logout', init)).text()).toBe('direct')
    expect(fetcher).toHaveBeenCalledWith('/api/auth/logout', init)
  })

  it('encrypts login and preserves opaque auth, query, idempotency, and application error status', async () => {
    const storage = memoryStorage()
    const received: RelayRequestPayload[] = []
    const relayFetch = fakeRelay(payload => {
      received.push(payload)
      if (payload.operation !== 'request') throw new Error('Unexpected upload')
      if (payload.path === '/api/auth/login') return reply(200, { user: { id: 'member-one' } }, 'sealed-session-one')
      return reply(403, { error: { code: 'ROLE_REQUIRED' } })
    })
    const transport = createApiTransport(config(), { relayFetch, storage, origin })
    const login = await transport.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'example', password: 'synthetic-password' }) })
    expect(login.status).toBe(200)
    const response = await transport.request('/api/raids/one/route/batches?test=one%20two', {
      method: 'POST', headers: { 'Idempotency-Key': 'same-batch', 'X-Kabanda-Client-Build': 'build1', Cookie: 'untrusted', Authorization: 'untrusted' }, body: '{}',
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: 'ROLE_REQUIRED' } })
    expect(received[1]).toMatchObject({ operation: 'request', session: 'sealed-session-one', path: '/api/raids/one/route/batches?test=one%20two', headers: { 'idempotency-key': 'same-batch', 'x-kabanda-client-build': 'build1' } })
    expect(received[1]?.operation === 'request' && received[1].headers).not.toHaveProperty('cookie')
    expect(received[1]?.operation === 'request' && received[1].headers).not.toHaveProperty('authorization')
    expect(JSON.stringify(relayFetch.mock.calls)).not.toContain('synthetic-password')
    expect(JSON.stringify(relayFetch.mock.calls)).not.toContain('sealed-session-one')
    expect(JSON.parse(storage.getItem(storageKey)!)).toEqual({ opaque: 'sealed-session-one', identityId: 'member-one' })
    transport.dispose()
  })

  it('accepts Request objects without losing their body, headers, method, or signal', async () => {
    const transport = createApiTransport(config(), { storage: memoryStorage(), origin, relayFetch: fakeRelay(payload => {
      expect(payload).toMatchObject({ operation: 'request', method: 'PATCH', path: '/api/kabandas/one?version=2', headers: { 'content-type': 'application/json', 'idempotency-key': 'request-object' }, body: { base64: btoa('{"name":"New name"}') } })
      return reply(200, { updated: true })
    }) })
    const request = new Request(`${origin}/api/kabandas/one?version=2`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'request-object' }, body: '{"name":"New name"}' })
    expect(await (await transport.request(request)).json()).toEqual({ updated: true })
    transport.dispose()
  })

  it('recovers a definite facade timeout using the same encrypted mutation and a new outer delivery ID', async () => {
    const responder = fakeRelay(() => reply(201, { invite: { id: 'one' } }))
    const relayFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit & { idempotencyKey?: string }) => {
      if (relayFetch.mock.calls.length === 1) return Response.json({ error: 'RELAY_TIMEOUT' }, { status: 503 })
      return responder(input, init)
    })
    const transport = createApiTransport(config(), { relayFetch, storage: memoryStorage(), origin })
    const response = await transport.request('/api/kabandas/one/invites', { method: 'POST', body: '{}' })
    expect(response.status).toBe(201)
    expect(relayFetch).toHaveBeenCalledTimes(2)
    const first = relayFetch.mock.calls[0]![1]!
    const second = relayFetch.mock.calls[1]![1]!
    expect(second.body).toBe(first.body)
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
    transport.dispose()
  })

  it('does not retry a decrypted application 503 and stops facade recovery at the overall deadline', async () => {
    const application = fakeRelay(() => reply(503, { error: { code: 'SERVER_BUSY' } }))
    const first = createApiTransport(config(), { relayFetch: application, storage: memoryStorage(), origin })
    expect((await first.request('/api/me')).status).toBe(503)
    expect(application).toHaveBeenCalledTimes(1)
    first.dispose()
    const relayFetch = vi.fn(async () => Response.json({ error: 'RELAY_BUSY' }, { status: 503 }))
    const second = createApiTransport(config(), { relayFetch, storage: memoryStorage(), origin, timeoutMs: 25 })
    await expect(second.request('/api/me')).rejects.toBeInstanceOf(TypeError)
    expect(relayFetch.mock.calls.length).toBeLessThanOrEqual(1)
    second.dispose()
  })

  it.each([403, 429, 502, 503])('keeps outer failure %s retryable without replaying an ambiguous operation', async status => {
    const storage = memoryStorage()
    storage.setItem(storageKey, JSON.stringify({ opaque: 'existing-session', identityId: 'member-one' }))
    const transport = createApiTransport(config(), { relayFetch: async () => new Response('denied by storage', { status }), storage, origin })
    const error = await transport.request('/api/raids/one/route/batches', { method: 'POST', body: '{}' }).catch(error => error)
    expect(error).toBeInstanceOf(TypeError)
    expect(error).not.toBeInstanceOf(ApiError)
    expect(storage.getItem(storageKey)).toContain('existing-session')
    transport.dispose()
  })

  it('preserves application 401 and clears an expired session when large-upload preparation rejects auth', async () => {
    const storage = memoryStorage()
    storage.setItem(storageKey, JSON.stringify({ opaque: 'expired-session', identityId: 'member-one' }))
    const fetchImpl = vi.fn()
    const relayFetch = fakeRelay(payload => {
      expect(payload).toMatchObject({ operation: 'upload', session: 'expired-session' })
      return reply(401, { error: { code: 'AUTH_REQUIRED' } }, null)
    })
    const transport = createApiTransport(config(), { relayFetch, fetchImpl, storage, origin })
    const response = await transport.request('/api/raids/one/media/intents/two/content', { method: 'PUT', body: new Blob([new Uint8Array(40_000)], { type: 'image/png' }) })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: { code: 'AUTH_REQUIRED' } })
    expect(storage.getItem(storageKey)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(relayFetch).toHaveBeenCalledTimes(1)
    transport.dispose()
  })

  it('round-trips an encrypted large binary upload with its original MIME, SHA and capability', async () => {
    const source = Uint8Array.from({ length: 65_000 }, (_, index) => index % 251)
    let ciphertext: Uint8Array | undefined
    let targetId: string | undefined
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe(objectUrl)
      expect(init).toMatchObject({ method: 'PUT', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/octet-stream' } })
      ciphertext = new Uint8Array(await new Response(init?.body).arrayBuffer())
      expect(ciphertext.byteLength).toBe(source.byteLength + 28)
      expect(ciphertext).not.toEqual(source)
      return new Response(null, { status: 200 })
    })
    const relayFetch = fakeRelay(async (payload, envelope, key) => {
      if (payload.operation === 'upload') {
        targetId = payload.targetId
        expect(payload.byteLength).toBe(source.byteLength + 28)
        return { operation: 'upload', url: objectUrl, ticket: 'upload-ticket-one' }
      }
      expect(envelope.id).toBe(targetId)
      expect(payload).toMatchObject({ method: 'PUT', body: { uploadTicket: 'upload-ticket-one' }, headers: { 'content-type': 'image/png', 'x-upload-capability': 'synthetic-capability', 'x-content-sha256': 'a'.repeat(64) } })
      expect(await decryptRelayBytes(key, envelope.id, 'body', ciphertext!)).toEqual(source)
      return reply(200, { media: { id: 'media-one' } })
    })
    const transport = createApiTransport(config(), { relayFetch, fetchImpl, storage: memoryStorage(), origin })
    const response = await transport.request('/api/raids/one/media/intents/intent-one/content', { method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'X-Upload-Capability': 'synthetic-capability', 'X-Content-SHA256': 'a'.repeat(64) }, body: new Blob([source]),
    })
    expect(await response.json()).toEqual({ media: { id: 'media-one' } })
    expect(relayFetch).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    transport.dispose()
  })

  it('decrypts a pointed binary response, preserves content type and strips synthetic Set-Cookie', async () => {
    let wire: unknown
    const image = Uint8Array.from([137, 80, 78, 71, 0, 255, 254])
    const relayFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as RelayEnvelope
      const opened = await openRelayRequest(privateKey, envelope)
      wire = await sealRelayResponse(opened.key, envelope.id, { operation: 'response', status: 200,
        headers: { 'content-type': 'image/png', 'Set-Cookie': 'never-a-browser-cookie', 'Content-Length': 'wrong' }, bodyBase64: relayBytesToBase64(image),
      })
      return Response.json({ version: 1, objectUrl })
    })
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(wire))
    const transport = createApiTransport(config(), { relayFetch, fetchImpl, storage: memoryStorage(), origin })
    const response = await transport.request('/api/raids/one/share-card')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(image)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(response.headers.has('content-length')).toBe(false)
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
    transport.dispose()
  })

  it.each([
    'http://storage.yandexcloud.net/kabanda-private/transport/v1/blobs/kabanda/one',
    'https://storage.yandexcloud.net/another-bucket/transport/v1/blobs/kabanda/one',
    'https://storage.yandexcloud.net/kabanda-private/transport/v1/blobs/encounter/one',
    'https://storage.yandexcloud.net/kabanda-private/transport/v1/blobs/kabanda/%2f..%2fother',
    'https://storage.yandexcloud.net.evil.test/kabanda-private/transport/v1/blobs/kabanda/one',
    'https://user:secret@storage.yandexcloud.net/kabanda-private/transport/v1/blobs/kabanda/one',
  ])('rejects a response pointer before requesting an unapproved URL: %s', async url => {
    expect(() => approvedRelayObjectUrl(url, bucket)).toThrow()
    const fetchImpl = vi.fn()
    const transport = createApiTransport(config(), { relayFetch: async () => Response.json({ version: 1, objectUrl: url }), fetchImpl, storage: memoryStorage(), origin })
    await expect(transport.request('/api/me')).rejects.toBeInstanceOf(TypeError)
    expect(fetchImpl).not.toHaveBeenCalled()
    transport.dispose()
  })

  it('prevents an in-flight login from restoring a session after logout and clears locally even if revoke fails', async () => {
    const storage = memoryStorage()
    storage.setItem(storageKey, JSON.stringify({ opaque: 'old-session', identityId: 'old-member' }))
    let release!: () => void
    let started!: () => void
    const didStart = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const relayFetch = fakeRelay(async payload => {
      if (payload.operation !== 'request') throw new Error('Unexpected upload')
      if (payload.path === '/api/auth/login') {
        started()
        await gate
        return reply(200, { user: { id: 'new-member' } }, 'new-session')
      }
      expect(payload).toMatchObject({ path: '/api/auth/logout', session: 'old-session' })
      throw new Error('Offline during revoke')
    })
    const transport = createApiTransport(config(), { relayFetch, storage, origin })
    const pending = transport.request('/api/auth/login', { method: 'POST', body: '{}' })
    const rejected = expect(pending).rejects.toBeInstanceOf(TypeError)
    await didStart
    await expect(transport.request('/api/auth/logout', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(TypeError)
    release()
    await rejected
    expect(storage.getItem(storageKey)).toBeNull()
    transport.dispose()
  })

  it('persists anonymous pending invites across reload and omits a body for 204 responses', async () => {
    const storage = memoryStorage()
    const first = createApiTransport(config(), { storage, origin, relayFetch: fakeRelay(() => reply(200, { invite: { continuation: 'synthetic' } }, 'pending-opaque')) })
    await first.request('/api/invites/preview', { method: 'POST', body: '{}' })
    first.dispose()
    const second = createApiTransport(config(), { storage, origin, relayFetch: fakeRelay(payload => {
      expect(payload.session).toBe('pending-opaque')
      return reply(204, null)
    }) })
    expect((await second.request('/api/invites/preview', { method: 'POST', body: '{"pending":true}' })).body).toBeNull()
    second.dispose()
  })

  it('honours an aborted caller without contacting storage', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('Cancelled by caller', 'AbortError'))
    const relayFetch = vi.fn()
    const transport = createApiTransport(config(), { relayFetch, storage: memoryStorage(), origin })
    await expect(transport.request('/api/me', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(relayFetch).not.toHaveBeenCalled()
    transport.dispose()
  })
})
