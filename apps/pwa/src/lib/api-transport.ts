import { createStorageRelayFetch } from '@motpavel/storage-relay-web'
import {
  createRelayKey,
  encryptRelayBytes,
  openRelayResponse,
  sealRelayRequest,
  relayBytesToBase64,
  relayBase64ToBytes,
  RELAY_INLINE_BODY_BYTES,
  RELAY_MAX_BODY_BYTES,
  RELAY_MAX_RESPONSE_BYTES,
  type RelayRequestPayload,
  type RelayResponsePayload,
} from '@kabanda/contracts/relay'

const SESSION_STORAGE_KEY = 'kabanda:relay-session:v1'
const INLINE_BODY_LIMIT = RELAY_INLINE_BODY_BYTES
const MAX_BODY_BYTES = RELAY_MAX_BODY_BYTES
const MAX_RESPONSE_BYTES = RELAY_MAX_RESPONSE_BYTES
const MAX_WIRE_BYTES = 48 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 75_000
const SESSION_ROUTES = new Set(['/api/auth/login', '/api/auth/verify', '/api/invites/preview', '/api/invites/accept'])

type Session = { opaque: string; identityId: string | null }
export type ApiTransportConfig = { bootstrapUrl: string; publicKey: string; storageBucket: string }
type RelayFetch = (input: RequestInfo | URL, init?: RequestInit & { idempotencyKey?: string; timeoutMs?: number }) => Promise<Response>
type Options = {
  fetchImpl?: typeof fetch
  relayFetch?: RelayFetch
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  origin?: string
  timeoutMs?: number
}

/** Presigned URLs are capability-bearing. Never follow a URL outside our exact storage bucket. */
export function approvedRelayObjectUrl(input: string, bucket: string): string {
  const url = new URL(input)
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || url.protocol !== 'https:' ||
      url.hostname !== 'storage.yandexcloud.net' || url.port || url.username || url.password || url.hash ||
      !url.pathname.startsWith(`/${bucket}/transport/v1/blobs/kabanda/`) ||
      /%2f|%5c|%2e/i.test(url.pathname)) throw new TypeError('Unapproved relay storage URL')
  return url.toString()
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(response.headers.get('content-length')) > MAX_WIRE_BYTES) throw new TypeError('Relay response is too large')
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_WIRE_BYTES) throw new TypeError('Relay response is too large')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally { reader.releaseLock() }
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  return joined
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

function sessionIdentity(path: string, bytes: Uint8Array): string | null {
  if (!['/api/auth/login', '/api/me'].includes(path)) return null
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { user?: { id?: unknown } }
    return typeof body.user?.id === 'string' ? body.user.id : null
  } catch { return null }
}

export function createApiTransport(config: ApiTransportConfig, options: Options = {}) {
  // These are public deployment settings, not auth credentials.
  const bootstrap = new URL(config.bootstrapUrl)
  if (bootstrap.protocol !== 'https:' || bootstrap.hostname !== 'storage.yandexcloud.net' || bootstrap.port ||
    bootstrap.username || bootstrap.password || bootstrap.hash || bootstrap.search || !bootstrap.pathname.endsWith('/bootstrap.json')) {
    throw new TypeError('Invalid relay bootstrap URL')
  }
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const relayFetch = options.relayFetch ?? createStorageRelayFetch({
    bootstrapUrl: config.bootstrapUrl,
    expectedAppId: 'kabanda',
    allowedStorageHosts: ['storage.yandexcloud.net'],
    fetchImpl,
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  })
  const origin = options.origin ?? window.location.origin
  let storage = options.storage
  if (!storage) { try { storage = localStorage } catch { /* Private browser modes may deny storage. */ } }
  let current: Session | null = null
  let epoch = 0
  let disposed = false
  try {
    const saved = JSON.parse(storage?.getItem(SESSION_STORAGE_KEY) ?? 'null') as Session | null
    if (saved && typeof saved.opaque === 'string' && saved.opaque.length <= 32_768 &&
      (saved.identityId === null || typeof saved.identityId === 'string')) current = saved
  } catch { /* A malformed or unavailable local session requires a fresh login. */ }

  const persist = () => {
    try {
      if (current) storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(current))
      else storage?.removeItem(SESSION_STORAGE_KEY)
    } catch { /* An in-memory session still works until this page closes. */ }
  }
  const clearSession = () => { epoch += 1; current = null; persist() }
  const identityChanged = (event: Event) => {
    const userId = (event as CustomEvent<{ userId: string | null }>).detail.userId
    if (!userId) {
      // A /me 401 in an anonymous invite flow must not erase its pending invite.
      if (current?.identityId) clearSession()
      return
    }
    if (current?.identityId && current.identityId !== userId) clearSession()
    else if (current && !current.identityId) { current = { ...current, identityId: userId }; persist() }
  }
  const storageChanged = (event: StorageEvent) => {
    if (event.key !== SESSION_STORAGE_KEY && event.key !== null) return
    epoch += 1
    current = null
    try {
      const saved = JSON.parse(event.newValue ?? 'null') as Session | null
      if (saved && typeof saved.opaque === 'string' && saved.opaque.length <= 32_768 &&
        (saved.identityId === null || typeof saved.identityId === 'string')) current = saved
    } catch { /* Ignore corrupt cross-tab state. */ }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('kabanda:identity-changed', identityChanged)
    window.addEventListener('storage', storageChanged)
  }

  const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (disposed) throw new TypeError('Relay transport is closed')
    const requestUrl = new URL(input instanceof Request ? input.url : String(input), origin)
    if (requestUrl.origin !== origin || !/^\/(?:kabanda\/)?api\//.test(requestUrl.pathname) || requestUrl.username || requestUrl.password || requestUrl.hash) {
      throw new TypeError('Relay only accepts this application API')
    }
    const path = requestUrl.pathname.replace(/^\/kabanda\/api\//, '/api/')
    const outgoing = new Request(input instanceof Request ? input : requestUrl, init)
    const snapshot = current
    const logout = path === '/api/auth/logout'
    if (logout) clearSession()
    else if (SESSION_ROUTES.has(path)) epoch += 1
    const startedEpoch = epoch
    const abort = new AbortController()
    const deadline = Date.now() + (options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    const externalSignal = outgoing.signal
    const externalAbort = () => abort.abort(externalSignal.reason)
    const timeout = setTimeout(() => abort.abort(new DOMException('Relay request timed out', 'TimeoutError')), options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    externalSignal.addEventListener('abort', externalAbort, { once: true })
    if (externalSignal.aborted) externalAbort()

    const assertCurrent = () => {
      abort.signal.throwIfAborted()
      if (disposed || startedEpoch !== epoch) throw new TypeError('Relay identity changed during request')
    }
    const exchange = async (id: string, payload: RelayRequestPayload, key?: CryptoKey) => {
      assertCurrent()
      const sealed = await sealRelayRequest(config.publicKey, id, payload, key)
      assertCurrent()
      const body = JSON.stringify(sealed.envelope)
      let deliveryId = id
      let retries = 0
      let response: Response
      while (true) {
        assertCurrent()
        response = await relayFetch('/relay/v1/request', {
          method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
          idempotencyKey: deliveryId, body, signal: abort.signal,
          timeoutMs: Math.max(1, deadline - Date.now()),
        })
        if (response.ok) break
        let code: unknown
        if (response.status === 503) {
          try { code = JSON.parse(new TextDecoder().decode(await readBoundedResponse(response, abort.signal)))?.error }
          catch { /* A non-facade error is left to the caller's existing network retry. */ }
        }
        // A definite facade timeout/busy response means the mutation may still be
        // running. Retry its exact envelope/id/key; only the outer delivery id
        // changes, so Storage Relay does not reuse a cached transient response.
        if (response.status === 503 && (code === 'RELAY_TIMEOUT' || code === 'RELAY_BUSY')) {
          await waitForRetry(Math.min(100 * 2 ** Math.min(retries++, 4), 1000), abort.signal)
          assertCurrent()
          deliveryId = crypto.randomUUID()
          continue
        }
        // Storage 403/429 is not an authenticated application error and must not
        // terminate an offline GPS or check-in queue.
        throw new TypeError('Relay transport could not deliver request')
      }
      let wire = JSON.parse(new TextDecoder().decode(await readBoundedResponse(response, abort.signal)))
      if (wire?.version === 1 && typeof wire.objectUrl === 'string') {
        const url = approvedRelayObjectUrl(wire.objectUrl, config.storageBucket)
        const object = await fetchImpl(url, { credentials: 'omit', mode: 'cors', redirect: 'error', cache: 'no-store', signal: abort.signal })
        if (!object.ok) throw new TypeError('Relay response object is unavailable')
        wire = JSON.parse(new TextDecoder().decode(await readBoundedResponse(object, abort.signal)))
      }
      const result = await openRelayResponse(sealed.key, id, wire)
      assertCurrent()
      return result
    }

    const applicationResponse = (result: RelayResponsePayload): Response => {
      if (result.operation !== 'response' || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 ||
        typeof result.bodyBase64 !== 'string' || !result.headers || typeof result.headers !== 'object') throw new TypeError('Invalid relay application response')
      const decoded = relayBase64ToBytes(result.bodyBase64)
      if (decoded.byteLength > MAX_RESPONSE_BYTES) throw new TypeError('Relay response is too large')
      const identityId = result.status >= 200 && result.status < 300 ? sessionIdentity(path, decoded) : null
      if (!logout && Object.hasOwn(result, 'session')) {
        if (result.session === null) { clearSession() }
        else if (typeof result.session === 'string' && result.session.length <= 32_768) {
          epoch += 1
          current = { opaque: result.session, identityId: identityId ?? snapshot?.identityId ?? null }; persist()
        } else throw new TypeError('Invalid relay session')
      } else if (!logout && identityId && current && current.identityId !== identityId) {
        current = { ...current, identityId }; persist()
      }
      const responseHeaders = new Headers(result.headers)
      responseHeaders.delete('set-cookie')
      responseHeaders.delete('content-length')
      responseHeaders.delete('content-encoding')
      return new Response(outgoing.method === 'HEAD' || [204, 205, 304].includes(result.status) ? null : decoded, {
        status: result.status, headers: responseHeaders,
      })
    }

    try {
      assertCurrent()
      const headers = Object.fromEntries(outgoing.headers.entries())
      for (const forbidden of ['cookie', 'authorization', 'host', 'origin', 'referer']) delete headers[forbidden]
      const bytes = new Uint8Array(await outgoing.arrayBuffer())
      if (bytes.byteLength > MAX_BODY_BYTES) throw new TypeError('Relay request is too large')
      const id = crypto.randomUUID()
      const key = await createRelayKey()
      let body: { base64: string } | { uploadTicket: string } | undefined
      if (bytes.byteLength > INLINE_BODY_LIMIT) {
        const encrypted = await encryptRelayBytes(key, id, 'body', bytes)
        const upload = await exchange(crypto.randomUUID(), {
          operation: 'upload', ...(snapshot ? { session: snapshot.opaque } : {}),
          targetId: id, byteLength: encrypted.byteLength,
        })
        if (upload.operation === 'response') return applicationResponse(upload)
        if (upload.operation !== 'upload' || typeof upload.url !== 'string' || typeof upload.ticket !== 'string') throw new TypeError('Invalid relay upload response')
        const url = approvedRelayObjectUrl(upload.url, config.storageBucket)
        const uploaded = await fetchImpl(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
          body: encrypted as Uint8Array<ArrayBuffer>, credentials: 'omit', mode: 'cors', redirect: 'error', signal: abort.signal })
        if (!uploaded.ok) throw new TypeError('Relay upload failed')
        body = { uploadTicket: upload.ticket }
      } else if (bytes.byteLength) body = { base64: relayBytesToBase64(bytes) }
      const result = await exchange(id, {
        operation: 'request', ...(snapshot ? { session: snapshot.opaque } : {}),
        method: outgoing.method as Extract<RelayRequestPayload, { operation: 'request' }>['method'], path: `${path}${requestUrl.search}`, headers, ...(body ? { body } : {}),
      }, key)
      return applicationResponse(result)
    } catch (error) {
      if (externalSignal.aborted) throw externalSignal.reason ?? new DOMException('Aborted', 'AbortError')
      if (error instanceof TypeError) throw error
      throw new TypeError('Relay network request failed', { cause: error })
    } finally {
      clearTimeout(timeout)
      externalSignal.removeEventListener('abort', externalAbort)
    }
  }

  return {
    request,
    clearSession,
    dispose() {
      disposed = true
      epoch += 1
      if (typeof window !== 'undefined') {
        window.removeEventListener('kabanda:identity-changed', identityChanged)
        window.removeEventListener('storage', storageChanged)
      }
    },
  }
}

let transport: ReturnType<typeof createApiTransport> | undefined
export function requestApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const bootstrapUrl = import.meta.env.VITE_RELAY_BOOTSTRAP_URL?.trim()
  const publicKey = import.meta.env.VITE_RELAY_PUBLIC_KEY?.replace(/\\n/g, '\n').trim()
  if (!bootstrapUrl && !publicKey) return fetch(input, init)
  if (!bootstrapUrl || !publicKey) return Promise.reject(new TypeError('Relay deployment configuration is incomplete'))
  try {
    transport ??= createApiTransport({ bootstrapUrl, publicKey, storageBucket: import.meta.env.VITE_RELAY_BLOB_BUCKET?.trim() ?? '' })
    return transport.request(input, init)
  } catch (error) { return Promise.reject(error) }
}
