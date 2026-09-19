import { notifyConfirmedWrite } from './api-events'
import { requestApi } from './api-transport'
import { diagnosticRequestHeaders } from './diagnostics'
import { ReadCache } from './read-cache'

const reads = new ReadCache()
export const evictApiReads = (matches: (path: string) => boolean) => reads.evict(key => matches(JSON.parse(key)[0]))
export const invalidateApiReads = () => reads.invalidate()
let identity: string | null | undefined
if (typeof window !== 'undefined') {
  window.addEventListener('kabanda:identity-changed', (event) => {
    const next = (event as CustomEvent<{ userId: string | null }>).detail.userId
    if (next !== identity) { identity = next; reads.invalidate(true) }
  })
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== 'kabanda:relay-session:v1') return
    identity = undefined
    try {
      const saved = JSON.parse(event.newValue ?? 'null') as { identityId?: unknown } | null
      if (saved && (saved.identityId === null || typeof saved.identityId === 'string')) identity = saved.identityId
    } catch { /* A corrupt or cleared session has no usable identity. */ }
    reads.invalidate(true)
  })
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly errorId: string | null = null,
    readonly apiBuild: string | null = null,
    readonly operationRef: string | null = null,
  ) {
    super(errorId ? `${message} Код: ${errorId.slice(0, 8)}` : message)
  }
}

/** Telemetry must not discard unrelated pending reads. Session/command writes
 * retain the conservative global fence. Only these exact, non-authorizing
 * endpoints use targeted eviction, AFTER the server acknowledges the write. */
export function telemetryReadScope(input: string, method: string): ((path: string) => boolean) | null {
  let path: string
  try { path = new URL(input, 'https://kabanda.invalid').pathname } catch { return null }
  const presence = method === 'PUT' && /^\/api\/raids\/([^/]+)\/presence\/me$/.exec(path)
  const route = method === 'POST' && /^\/api\/raids\/([^/]+)\/route\/batches$/.exec(path)
  const match = presence || route
  if (!match) return null
  const prefix = `/api/raids/${match[1]}`
  return candidate => {
    let pathname: string
    try { pathname = new URL(candidate, 'https://kabanda.invalid').pathname } catch { return false }
    return pathname === `${prefix}/live` || (presence
      ? pathname === `${prefix}/presence` || pathname === `${prefix}/check-ins/presence`
      : pathname === `${prefix}/route/track`)
  }
}

export function requestJson<T>(input: RequestInfo | URL, init?: RequestInit, options?: { maxAgeMs?: number }): Promise<T> {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const operation = () => performJsonRequest<T>(input, init)
  if (method !== 'GET' && method !== 'HEAD') {
    const requestIdentity = identity
    const path = input instanceof Request ? input.url : String(input)
    const targeted = telemetryReadScope(path, method)
    return (targeted ? operation() : reads.mutate(operation)).then(body => {
      if (requestIdentity === identity) {
        if (targeted) evictApiReads(targeted)
        notifyConfirmedWrite({ identityId: requestIdentity, path, body })
      }
      return body
    })
  }
  // A caller-owned abort signal must not cancel another consumer's shared read.
  if (init?.signal || input instanceof Request) return operation()
  const key = JSON.stringify([String(input), method, [...new Headers(init?.headers).entries()].sort(), init?.credentials ?? 'same-origin'])
  return reads.read(key, operation, options?.maxAgeMs)
}

async function performJsonRequest<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await requestApi(input, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...diagnosticRequestHeaders(), ...init?.headers },
  })
  const body = response.status === 204 ? null : await response.json()
  if (!response.ok) {
    const error = body?.error
    throw new ApiError(
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? 'Ошибка запроса',
      response.status,
      error?.errorId ?? response.headers.get('X-Kabanda-Request-Id'),
      response.headers.get('X-Kabanda-Api-Build'),
      error?.operationRef ?? response.headers.get('X-Kabanda-Operation-Ref'),
    )
  }
  return body as T
}
