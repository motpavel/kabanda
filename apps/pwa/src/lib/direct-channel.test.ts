import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDirectChannel } from './direct-channel'
const base = 'https://direct.example/kabanda/relay/v1'
const instanceId = '34c37c1b-d00a-4b88-8ac7-dd0a9794880b'
const health = () => Response.json({ status: 'ok', directVersion: 1, instanceId, serverTime: Date.now() })
afterEach(() => vi.useRealTimers())
describe('direct channel selection', () => {
  it('shares probes, caches success, and resets after a network change', async () => {
    const fetcher = vi.fn(async () => health())
    const channel = createDirectChannel(base, fetcher)
    const signal = new AbortController().signal
    const leases = await Promise.all([channel.prepare(signal), channel.prepare(signal)])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(leases[0]?.instanceId).toBe(instanceId)
    await channel.prepare(signal)
    expect(fetcher).toHaveBeenCalledTimes(1)
    channel.reset()
    await channel.prepare(signal)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('times out blocked probes and avoids delaying every subsequent request', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch
    const channel = createDirectChannel(base, fetcher)
    const signal = new AbortController().signal
    const pending = channel.prepare(signal)
    await vi.advanceTimersByTimeAsync(1500)
    expect(await pending).toBeUndefined()
    expect(await channel.prepare(signal)).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    const again = channel.prepare(signal)
    await vi.advanceTimersByTimeAsync(1500)
    await again
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('allows one cancelled caller without cancelling another shared probe', async () => {
    let finish!: (r: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    const channel = createDirectChannel(base, fetcher)
    const abort = new AbortController()
    const first = channel.prepare(abort.signal)
    const second = channel.prepare(new AbortController().signal)
    abort.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    finish(health())
    expect((await second)?.instanceId).toBe(instanceId)
  })
  it('aborts a stalled body as well as a stalled connection', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason))
    } }))) as typeof fetch
    const channel = createDirectChannel(base, fetcher)
    const pending = channel.send('{}', new AbortController().signal)
    const failure = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(2500)
    await failure
  })
  it('rejects insecure URLs and malformed health before sending application data', async () => {
    expect(() => createDirectChannel('http://direct.example/relay/v1', fetch)).toThrow()
    const fetcher = vi.fn(async () => Response.json({ status: 'ok' }))
    expect(await createDirectChannel(base, fetcher).prepare(new AbortController().signal)).toBeUndefined()
  })
})
