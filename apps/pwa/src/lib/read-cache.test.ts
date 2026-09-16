import { describe, expect, it, vi } from 'vitest'
import { ReadCache } from './read-cache'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('shared API reads', () => {
  it('shares an in-flight request without sharing mutable consumer objects', async () => {
    const cache = new ReadCache(), response = deferred<{ ids: string[] }>()
    const fetch = vi.fn(() => response.promise)
    const first = cache.read('raid', fetch), second = cache.read('raid', fetch)
    response.resolve({ ids: ['one'] })
    const a = await first, b = await second
    a.ids.push('changed')
    expect(b.ids).toEqual(['one'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('invalidates cached reads and in-flight cache writes across mutations', async () => {
    const cache = new ReadCache(), old = deferred<string>()
    await cache.read('cached', async () => 'before', 1000)
    const pending = cache.read('pending', () => old.promise, 1000)
    await cache.mutate(async () => undefined)
    old.resolve('old response')
    await pending
    expect(await cache.read('cached', async () => 'after', 1000)).toBe('after')
    expect(await cache.read('pending', async () => 'new response', 1000)).toBe('new response')
  })

  it('never delivers an old identity response after account change', async () => {
    const cache = new ReadCache(), old = deferred<string>()
    const pending = cache.read('same URL', () => old.promise, 1000)
    cache.invalidate(true)
    old.resolve('private old account')
    await expect(pending).rejects.toThrow('Identity changed')
    expect(await cache.read('same URL', async () => 'new account', 1000)).toBe('new account')
  })

  it('does not remember failures or reads made during a mutation', async () => {
    const cache = new ReadCache(), mutation = deferred<void>()
    await expect(cache.read('key', async () => { throw new Error('offline') }, 1000)).rejects.toThrow('offline')
    const writing = cache.mutate(() => mutation.promise)
    expect(await cache.read('key', async () => 'before commit', 1000)).toBe('before commit')
    mutation.resolve()
    await writing
    expect(await cache.read('key', async () => 'after commit', 1000)).toBe('after commit')
  })

  it('fences a late authentication failure from the previous account', async () => {
    const cache = new ReadCache()
    let reject!: (error: Error) => void
    const response = new Promise<string>((_, fail) => { reject = fail })
    const pending = cache.read('/me', () => response)
    cache.invalidate(true)
    reject(Object.assign(new Error('Old account unauthorized'), { status: 401 }))
    await expect(pending).rejects.toThrow('Identity changed during read')
  })

  it('expires a successful read and lets explicit zero-age reads revalidate', async () => {
    const cache = new ReadCache()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      await cache.read('key', async () => 'cached', 100)
      expect(await cache.read('key', async () => 'unused', 100)).toBe('cached')
      expect(await cache.read('key', async () => 'fresh')).toBe('fresh')
      clock.mockReturnValue(1100)
      expect(await cache.read('key', async () => 'expired', 100)).toBe('expired')
    } finally { clock.mockRestore() }
  })
})
