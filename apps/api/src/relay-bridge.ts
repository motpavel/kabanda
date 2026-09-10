import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  decryptRelayBytes,
  openRelayRequest,
  RELAY_INLINE_BODY_BYTES,
  RELAY_MAX_BODY_BYTES,
  RELAY_MAX_RESPONSE_BYTES,
  sealRelayResponse,
} from '@kabanda/contracts'

export interface RelayBlobStore {
  prepareUpload(input: { id: string; byteLength: number; owner: string }): Promise<{ url: string; ticket: string }>
  readUpload(input: { ticket: string; id: string; owner: string }): Promise<Uint8Array>
  publishResponse(input: { id: string; body: Uint8Array }): Promise<string>
}

export interface RelayBridgeDependencies {
  app: FastifyInstance
  publicOrigin: string
  cookieName: string
  pendingInviteCookieName: string
  sessionSecret: string
  privateKeyPkcs8Pem: string
  blobs: RelayBlobStore
  now?: () => number
  deadlineMs?: number
}

const maxBodyBytes = RELAY_MAX_BODY_BYTES
const maxInlineBodyBytes = RELAY_INLINE_BODY_BYTES
const maxInlineResponseBytes = 96 * 1024
const maxReplayEntries = 1024
const maxConcurrentRequests = 32
const maxReplayBytes = 16 * 1024 * 1024
const replayLifetimeMs = 120_000
const maxSessionAgeMs = 90 * 24 * 60 * 60 * 1000
const requestHeaderNames = new Set([
  'accept', 'content-type', 'idempotency-key', 'x-upload-capability', 'x-content-sha256',
  'x-kabanda-diagnostic-session', 'x-kabanda-client-build', 'if-none-match', 'if-modified-since', 'range',
])
const responseHeaderNames = new Set([
  'content-type', 'content-disposition', 'cache-control', 'etag', 'last-modified', 'content-range',
  'accept-ranges', 'retry-after', 'x-kabanda-request-id', 'x-kabanda-api-build',
  'x-kabanda-app-build', 'x-kabanda-operation-ref',
])
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/
const base64Length = (value: string) => value.length % 4 === 0
const opaqueSessionSchema = z.string().max(16_384).optional()
const requestSchema = z.strictObject({
  operation: z.literal('request'),
  session: opaqueSessionSchema,
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(5).max(8192),
  headers: z.record(z.string().max(128), z.string().max(8192)).refine((headers) => Object.keys(headers).length <= 16),
  body: z.union([
    z.strictObject({ base64: z.string().max(Math.ceil(maxInlineBodyBytes / 3) * 4).regex(base64Pattern).refine(base64Length) }),
    z.strictObject({ uploadTicket: z.string().min(1).max(8192) }),
  ]).optional(),
})
const uploadSchema = z.strictObject({
  operation: z.literal('upload'),
  session: opaqueSessionSchema,
  targetId: z.uuid(),
  byteLength: z.number().int().min(1).max(maxBodyBytes + 1024),
})
const payloadSchema = z.discriminatedUnion('operation', [requestSchema, uploadSchema])
const wireSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  wrappedKey: z.string().min(1).max(2048).regex(base64Pattern).refine(base64Length),
  iv: z.string().min(1).max(64).regex(base64Pattern).refine(base64Length),
  ciphertext: z.string().min(1).max(220_000).regex(base64Pattern).refine(base64Length),
})
const jarSchema = z.strictObject({
  version: z.literal(1),
  issuedAt: z.number().int(),
  cookies: z.array(z.strictObject({
    name: z.string().max(100),
    value: z.string().min(1).max(4096).regex(/^[!#-+\--:<-\[\]-~]+$/),
    expiresAt: z.number().int(),
  })).max(2),
})
type CookieJar = z.infer<typeof jarSchema>['cookies']
type RequestPayload = z.infer<typeof requestSchema>
type BridgeResult = Awaited<ReturnType<typeof sealRelayResponse>> | { version: 1; objectUrl: string }

class InvalidSession extends Error {}
class RelayDeadline extends Error {}

function validApiPath(path: string): boolean {
  if (!path.startsWith('/api/') || /[\u0000-\u0020\u007f\\#]/.test(path)) return false
  let pathname = path.split('?')[0]!
  for (let index = 0; index < 4; index += 1) {
    if (!pathname.startsWith('/api/') || pathname.includes('//') || /[\\?#\u0000-\u0020\u007f]/.test(pathname)) return false
    if (pathname.split('/').some((segment) => segment === '.' || segment === '..')) return false
    if (!pathname.includes('%')) return true
    try {
      const decoded = decodeURIComponent(pathname)
      if (decoded === pathname) return true
      pathname = decoded
    } catch {
      return false
    }
  }
  return false
}

function safeRequestHeaders(headers: Record<string, string>): Record<string, string> | null {
  const result: Record<string, string> = Object.create(null)
  let totalBytes = 0
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (!requestHeaderNames.has(key) || key in result || /[\r\n\u0000]/.test(value)) return null
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value)
    if (totalBytes > 16_384) return null
    result[key] = value
  }
  return result
}

function errorResponse(status: number, code: string, session?: null) {
  return {
    operation: 'response' as const,
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    bodyBase64: Buffer.from(JSON.stringify({ error: { code, message: code === 'AUTH_REQUIRED' ? 'Нужно войти в КАБАНДУ' : 'Не удалось передать запрос' } })).toString('base64'),
    ...(session === null ? { session: null } : {}),
  }
}

/** Private loopback facade. The original API still authenticates and authorizes every request. */
export async function buildRelayBridge(dependencies: RelayBridgeDependencies): Promise<FastifyInstance> {
  if (dependencies.sessionSecret.length < 32) throw new Error('Relay session secret must contain at least 32 characters')
  const origin = new URL(dependencies.publicOrigin)
  if (origin.origin !== dependencies.publicOrigin || origin.protocol !== 'https:') throw new Error('Relay requires a canonical HTTPS app origin')
  const now = dependencies.now ?? Date.now
  const cookieNames = new Set([dependencies.cookieName, dependencies.pendingInviteCookieName])
  if (cookieNames.size !== 2) throw new Error('Relay cookie names must be distinct')
  const jarKey = createHash('sha256').update('kabanda-relay-cookie-jar-v1\0').update(dependencies.sessionSecret).digest()
  const jarContext = Buffer.from(`kabanda-relay-cookie-jar-v1:${origin.origin}`)
  const relay = Fastify({ logger: false, bodyLimit: 256 * 1024, requestTimeout: 20_000 })
  const replay = new Map<string, { fingerprint: string; expiresAt: number; settled: boolean; bytes: number; result: Promise<BridgeResult> }>()
  let replayBytes = 0

  function forgetReplay(id: string) {
    const previous = replay.get(id)
    if (previous) replayBytes -= previous.bytes
    replay.delete(id)
  }

  function openJar(session?: string): CookieJar {
    if (!session) return []
    try {
      const parts = session.split('.')
      if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new InvalidSession()
      const iv = Buffer.from(parts[1]!, 'base64url')
      const ciphertext = Buffer.from(parts[2]!, 'base64url')
      const tag = Buffer.from(parts[3]!, 'base64url')
      if (iv.length !== 12 || tag.length !== 16) throw new InvalidSession()
      const decipher = createDecipheriv('aes-256-gcm', jarKey, iv)
      decipher.setAAD(jarContext)
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      const parsed = jarSchema.parse(JSON.parse(plaintext.toString('utf8')))
      if (parsed.issuedAt > now() + 30_000 || parsed.issuedAt < now() - maxSessionAgeMs) throw new InvalidSession()
      if (parsed.cookies.some((item) => !cookieNames.has(item.name)) || new Set(parsed.cookies.map((item) => item.name)).size !== parsed.cookies.length) throw new InvalidSession()
      return parsed.cookies.filter((item) => item.expiresAt > now())
    } catch {
      throw new InvalidSession()
    }
  }

  function sealJar(cookies: CookieJar): string | null {
    if (!cookies.length) return null
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', jarKey, iv)
    cipher.setAAD(jarContext)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ version: 1, issuedAt: now(), cookies })), cipher.final()])
    return `v1.${iv.toString('base64url')}.${encrypted.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`
  }

  function updateJar(jar: CookieJar, setCookies: string[]): string | null | undefined {
    const cookies = new Map(jar.map((item) => [item.name, item]))
    let changed = false
    for (const serialized of setCookies) {
      const [pair, ...attributes] = serialized.split(';').map((part) => part.trim())
      if (!pair) continue
      const separator = pair.indexOf('=')
      const name = pair.slice(0, separator)
      if (separator < 1 || !cookieNames.has(name)) continue
      changed = true
      const value = pair.slice(separator + 1)
      const maxAge = attributes.find((item) => /^max-age=/i.test(item))?.slice(8)
      const expires = attributes.find((item) => /^expires=/i.test(item))?.slice(8)
      const maxAgeMs = name === dependencies.pendingInviteCookieName ? 30 * 60 * 1000 : maxSessionAgeMs
      const expiry = maxAge !== undefined && /^-?\d+$/.test(maxAge)
        ? now() + Number(maxAge) * 1000
        : expires !== undefined ? Date.parse(expires) : now() + maxAgeMs
      cookies.delete(name)
      if (value && Number.isFinite(expiry) && expiry > now()) {
        const entry = jarSchema.shape.cookies.element.parse({ name, value, expiresAt: Math.min(expiry, now() + maxAgeMs) })
        cookies.set(name, entry)
      }
    }
    return changed ? sealJar([...cookies.values()]) : undefined
  }

  function identity(jar: CookieJar, payload?: RequestPayload, body?: Buffer): string {
    // Credential attempts share one limiter per normalized account, including after login.
    if (payload?.method === 'POST' && ['/api/auth/login', '/api/auth/request-link', '/api/invites/accept'].includes(payload.path.split('?')[0]!) && body) {
      try {
        const input: unknown = JSON.parse(body.toString('utf8'))
        if (input && typeof input === 'object') {
          const candidate = 'username' in input ? input.username : 'email' in input ? input.email : undefined
          if (typeof candidate === 'string' && candidate.length <= 320) return `account:${candidate.trim().toLowerCase()}`
        }
      } catch { /* The API handles malformed JSON. */ }
    }
    return jar.find((item) => item.name === dependencies.cookieName)?.value
      ?? jar.find((item) => item.name === dependencies.pendingInviteCookieName)?.value
      ?? 'anonymous'
  }

  function injectHeaders(jar: CookieJar, supplied: Record<string, string>, subject: string): Record<string, string> {
    const hash = createHmac('sha256', jarKey).update(`rate-limit:${subject}`).digest('hex').slice(0, 28)
    const ip = `fd00:${hash.match(/.{4}/g)!.join(':')}`
    return {
      ...supplied,
      host: origin.host,
      origin: origin.origin,
      'x-forwarded-proto': 'https',
      'x-forwarded-for': ip,
      ...(jar.length ? { cookie: jar.map((item) => `${item.name}=${item.value}`).join('; ') } : {}),
    }
  }

  async function authenticatedOwner(jar: CookieJar): Promise<string | null> {
    if (!jar.some((item) => item.name === dependencies.cookieName)) return null
    const me = await dependencies.app.inject({
      method: 'GET', url: '/api/me', remoteAddress: '127.0.0.1',
      headers: injectHeaders(jar, {}, identity(jar)),
    })
    if (me.statusCode === 401 || me.statusCode === 403) return null
    if (me.statusCode !== 200) throw new Error('Relay authentication service unavailable')
    const data = z.object({ user: z.object({ id: z.uuid() }) }).safeParse(me.json())
    if (!data.success) throw new Error('Invalid relay authentication response')
    return data.data.user.id
  }

  async function processRequest(wire: z.infer<typeof wireSchema>): Promise<BridgeResult> {
    const { key, payload: decrypted } = await openRelayRequest(dependencies.privateKeyPkcs8Pem, wire)
    const parsed = payloadSchema.safeParse(decrypted)
    let response: Parameters<typeof sealRelayResponse>[2]
    if (!parsed.success) {
      response = errorResponse(400, 'INVALID_RELAY_REQUEST')
    } else {
      const payload = parsed.data
      let jar: CookieJar
      try { jar = openJar(payload.session) } catch { return sealRelayResponse(key, wire.id, errorResponse(401, 'AUTH_REQUIRED', null)) }
      const cached = replay.get(wire.id)
      if (cached && jar.length) cached.expiresAt = Math.min(cached.expiresAt, ...jar.map((item) => item.expiresAt))
      if (payload.operation === 'upload') {
        const owner = await authenticatedOwner(jar)
        response = owner
          ? { operation: 'upload', ...await dependencies.blobs.prepareUpload({ id: payload.targetId, byteLength: payload.byteLength, owner }) }
          : errorResponse(401, 'AUTH_REQUIRED', null)
      } else {
        const headers = safeRequestHeaders(payload.headers)
        if (!validApiPath(payload.path) || !headers || (['GET', 'HEAD'].includes(payload.method) && payload.body)) {
          response = errorResponse(400, 'INVALID_RELAY_REQUEST')
        } else {
          let body: Buffer | undefined
          if (payload.body && 'uploadTicket' in payload.body) {
            const owner = await authenticatedOwner(jar)
            if (!owner) return sealRelayResponse(key, wire.id, errorResponse(401, 'AUTH_REQUIRED', null))
            const encrypted = await dependencies.blobs.readUpload({ ticket: payload.body.uploadTicket, id: wire.id, owner })
            if (encrypted.byteLength > maxBodyBytes + 1024) return sealRelayResponse(key, wire.id, errorResponse(413, 'PAYLOAD_TOO_LARGE'))
            body = Buffer.from(await decryptRelayBytes(key, wire.id, 'body', encrypted))
          } else if (payload.body) {
            body = Buffer.from(payload.body.base64, 'base64')
          }
          if (body && body.byteLength > maxBodyBytes) {
            response = errorResponse(413, 'PAYLOAD_TOO_LARGE')
          } else {
            const result = await dependencies.app.inject({
              method: payload.method, url: payload.path, remoteAddress: '127.0.0.1',
              headers: injectHeaders(jar, headers, identity(jar, payload, body)),
              ...(body ? { payload: body } : {}),
            })
            const responseHeaders: Record<string, string> = {}
            for (const [name, value] of Object.entries(result.headers)) {
              if (responseHeaderNames.has(name) && value !== undefined) responseHeaders[name] = Array.isArray(value) ? value.join(', ') : String(value)
            }
            const setCookie = result.headers['set-cookie']
            const session = updateJar(jar, setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [String(setCookie)])
            if (result.rawPayload.byteLength > RELAY_MAX_RESPONSE_BYTES) throw new Error('Relay response limit exceeded')
            response = {
              operation: 'response', status: result.statusCode, headers: responseHeaders,
              bodyBase64: result.rawPayload.toString('base64'),
              ...(session !== undefined ? { session } : {}),
            }
          }
        }
      }
    }
    const encrypted = await sealRelayResponse(key, wire.id, response)
    const bytes = Buffer.from(JSON.stringify(encrypted))
    if (bytes.byteLength <= maxInlineResponseBytes) return encrypted
    return { version: 1, objectUrl: await dependencies.blobs.publishResponse({ id: wire.id, body: bytes }) }
  }

  relay.get('/relay/v1/health', async () => ({ status: 'ok' }))
  relay.post('/relay/v1/request', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = wireSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(502).send({ error: 'INVALID_RELAY_ENVELOPE' })
    const wire = parsed.data
    const serializedWire = JSON.stringify(wire)
    const fingerprint = createHash('sha256').update(serializedWire).digest('hex')
    for (const [id, entry] of replay) if (entry.settled && entry.expiresAt <= now()) forgetReplay(id)
    let entry = replay.get(wire.id)
    if (entry && entry.fingerprint !== fingerprint) return reply.status(502).send({ error: 'RELAY_REQUEST_ID_CONFLICT' })
    if (!entry) {
      const active = [...replay.values()].filter((item) => !item.settled).length
      const reservedBytes = Buffer.byteLength(serializedWire) * 2 + maxInlineResponseBytes + 256
      if (replay.size >= maxReplayEntries || active >= maxConcurrentRequests || replayBytes + reservedBytes > maxReplayBytes) {
        return reply.status(503).send({ error: 'RELAY_BUSY' })
      }
      entry = {
        fingerprint, expiresAt: now() + replayLifetimeMs, settled: false, bytes: reservedBytes,
        result: processRequest(wire).catch(() => { throw new Error('Relay request failed') }),
      }
      replay.set(wire.id, entry)
      replayBytes += reservedBytes
      const current = entry
      void current.result.then((result) => {
        if (replay.get(wire.id) !== current) return
        const bytes = Buffer.byteLength(JSON.stringify(result)) + 256
        replayBytes += bytes - current.bytes
        current.bytes = bytes
        current.settled = true
      }, () => {
        if (replay.get(wire.id) !== current) return
        // The API may already have committed before encrypting/publishing the reply failed.
        // Retain the failure so a transport retry cannot execute that mutation again.
        replayBytes += 256 - current.bytes
        current.bytes = 256
        current.settled = true
      })
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        entry.result,
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new RelayDeadline()), dependencies.deadlineMs ?? 18_000) }),
      ])
      return reply.send(result)
    } catch (error) {
      return reply.status(error instanceof RelayDeadline ? 503 : 502).send({ error: error instanceof RelayDeadline ? 'RELAY_TIMEOUT' : 'RELAY_UNAVAILABLE' })
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  })
  relay.setErrorHandler((_error, _request, reply) => reply.status(502).send({ error: 'RELAY_UNAVAILABLE' }))
  relay.addHook('onClose', async () => { replay.clear(); replayBytes = 0 })
  return relay
}
