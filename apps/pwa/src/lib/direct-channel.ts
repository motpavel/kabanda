/** Direct and Storage delivery share the same encrypted request and replay identity. */
export type DeliveryLease = { instanceId: string; expiresAt: number }
const PROBE_TIMEOUT = 1500
const DIRECT_TIMEOUT = 2500
const COOLDOWN = 60_000

async function boundedFetch(fetcher: typeof fetch, url: string, init: RequestInit, timeout: number, limit: number) {
  const controller = new AbortController()
  const abort = () => controller.abort(init.signal?.reason)
  init.signal?.addEventListener('abort', abort, { once: true })
  if (init.signal?.aborted) abort()
  const timer = setTimeout(() => controller.abort(new DOMException('Direct connection timed out', 'TimeoutError')), timeout)
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal, credentials: 'omit', mode: 'cors', redirect: 'error', cache: 'no-store' })
    if (!response.ok) throw new TypeError('Direct connection unavailable')
    if (Number(response.headers.get('content-length')) > limit) throw new TypeError('Direct response too large')
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    if (reader) {
      try {
        while (true) {
          controller.signal.throwIfAborted()
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > limit) throw new TypeError('Direct response too large')
          chunks.push(value)
        }
      } catch (error) { await reader.cancel().catch(() => undefined); throw error }
      finally { reader.releaseLock() }
    }
    controller.signal.throwIfAborted()
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new Response(bytes, { status: response.status, headers: response.headers })
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', abort)
  }
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function createDirectChannel(baseUrl: string, fetcher: typeof fetch) {
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.port || !base.pathname.endsWith('/relay/v1')) {
    throw new TypeError('Invalid direct relay URL')
  }
  let state: { instanceId: string; offset: number; checkedAt: number } | undefined
  let blockedUntil = 0
  let generation = 0
  let probe: Promise<void> | undefined
  const failed = () => { generation++; state = undefined; blockedUntil = Date.now() + COOLDOWN }
  const reset = () => { generation++; state = undefined; blockedUntil = 0 }
  const prepare = async (signal: AbortSignal): Promise<DeliveryLease | undefined> => {
    signal.throwIfAborted()
    if (Date.now() < blockedUntil) return undefined
    if (!state || Date.now() - state.checkedAt >= COOLDOWN) {
      if (!probe) {
        const startedGeneration = generation
        probe = (async () => {
          try {
            const response = await boundedFetch(fetcher, `${base}/health`, {}, PROBE_TIMEOUT, 4096)
            const health = await response.json()
            if (health.status !== 'ok' || health.directVersion !== 1 ||
              !/^[0-9a-f-]{36}$/.test(health.instanceId) || !Number.isSafeInteger(health.serverTime)) throw new TypeError('Invalid direct health')
            if (generation === startedGeneration) state = { instanceId: health.instanceId, offset: health.serverTime - Date.now(), checkedAt: Date.now() }
          } catch { if (generation === startedGeneration) failed() }
        })().finally(() => { probe = undefined })
      }
      await cancellable(probe, signal)
    }
    signal.throwIfAborted()
    return state ? { instanceId: state.instanceId, expiresAt: Date.now() + state.offset + 90_000 } : undefined
  }
  return {
    prepare, failed, reset,
    send: (body: string, signal: AbortSignal) => boundedFetch(fetcher, `${base}/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal,
    }, DIRECT_TIMEOUT, 512 * 1024),
  }
}
