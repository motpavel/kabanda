import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCityArchiveStore, MAX_CITY_ARCHIVE_BYTES, type CityArchiveSpec } from './archive-store'

const databases: string[] = []
const oldBytes = 'old offline city archive'
const newBytes = 'new offline city archive'
const spec = (body = newBytes, version = '2026-09'): CityArchiveSpec => ({
  version, url: `/maps/izhevsk-${version}.pmtiles`, bytes: new Blob([body]).size,
  sha256: body === oldBytes ? 'efffb2411f3c09db3abc67b341bf77e0586736c456882d2c838896d75bc581c3'
    : 'bdbc27f8a4ff51db4f07c09e8d1a79a3efd630a34c837a36bb25c38784362d20',
})
const ampleStorage = () => ({
  estimate: vi.fn(async () => ({ quota: 500 * 1024 * 1024, usage: 0 })),
  persist: vi.fn(async () => true),
})
function setup(options: Parameters<typeof createCityArchiveStore>[0] = {}) {
  const databaseName = `offline-city-test-${databases.length}-${Math.random()}`
  databases.push(databaseName)
  const fetcher = vi.fn(async () => new Response(newBytes))
  const storage = ampleStorage()
  const store = createCityArchiveStore({ databaseName, fetcher, storage, online: () => true, saveData: () => false, ...options })
  return { store, fetcher, storage, databaseName }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(databases.splice(0).map(name => Dexie.delete(name)))
})

describe('offline city archive', () => {
  it('deduplicates callers and only announces ready after bytes are verified and saved', async () => {
    const { store, fetcher, storage } = setup()
    const states: string[] = []
    const unsubscribe = store.subscribe(() => states.push(store.getSnapshot().status))
    const first = store.ensure(spec())
    const second = store.ensure(spec())
    expect(second).toBe(first)
    expect(await (await first)?.text()).toBe(newBytes)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('https://localhost/maps/izhevsk-2026-09.pmtiles', expect.objectContaining({ cache: 'no-store' }))
    expect(states).toContain('downloading')
    expect(states.at(-1)).toBe('ready')
    expect(store.getSnapshot()).toMatchObject({ progress: 100, cachedVersion: spec().version, downloadedBytes: spec().bytes })
    expect(await (await store.read(spec()))?.blob.text()).toBe(newBytes)
    expect((await store.read(spec()))?.blob.type).toBe('application/octet-stream')
    expect(storage.persist).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('reads the verified archive after reopening while offline without a request', async () => {
    const { store, databaseName } = setup()
    await store.ensure(spec())
    const fetcher = vi.fn()
    const reopened = createCityArchiveStore({ databaseName, fetcher, online: () => false })
    expect(await (await reopened.ensure(spec()))?.text()).toBe(newBytes)
    expect(reopened.getSnapshot().status).toBe('ready')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('preserves the previous archive when a replacement stream stops early, and requires explicit retry', async () => {
    const { store, fetcher } = setup()
    fetcher.mockResolvedValueOnce(new Response(oldBytes))
    await store.ensure(spec(oldBytes, 'old'))
    fetcher.mockResolvedValueOnce(new Response('partial'))
    expect(await store.ensure(spec())).toBeNull()
    expect(store.getSnapshot()).toMatchObject({ status: 'error', cachedVersion: 'old' })
    expect(await (await store.read())?.blob.text()).toBe(oldBytes)
    expect(await store.read(spec())).toBeNull()
    await store.ensure(spec())
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await (await store.ensure(spec(), { manual: true }))?.text()).toBe(newBytes)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('preserves the old archive on stream failure even if some chunks have arrived', async () => {
    const { store, fetcher } = setup()
    fetcher.mockResolvedValueOnce(new Response(oldBytes))
    await store.ensure(spec(oldBytes, 'old'))
    let pulled = false
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({
      pull(controller) {
        if (pulled) controller.error(new Error('connection lost'))
        else { pulled = true; controller.enqueue(new TextEncoder().encode('new ')) }
      },
    })))
    expect(await store.ensure(spec())).toBeNull()
    expect(await (await store.read())?.blob.text()).toBe(oldBytes)
  })

  it('rejects a complete but corrupt download without replacing the old archive', async () => {
    const { store, fetcher } = setup()
    fetcher.mockResolvedValueOnce(new Response(oldBytes))
    await store.ensure(spec(oldBytes, 'old'))
    expect(await store.ensure({ ...spec(), sha256: '0'.repeat(64) })).toBeNull()
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: expect.stringContaining('повреждён') })
    expect(await (await store.read())?.blob.text()).toBe(oldBytes)
  })

  it('leaves headroom for the old copy and stops before fetching when storage is low', async () => {
    const { store, fetcher, storage } = setup()
    fetcher.mockResolvedValueOnce(new Response(oldBytes))
    await store.ensure(spec(oldBytes, 'old'))
    storage.estimate.mockResolvedValue({ quota: 1024, usage: 1000 })
    expect(await store.ensure(spec())).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().error).toContain('Недостаточно места')
    expect(await (await store.read())?.blob.text()).toBe(oldBytes)
  })

  it('rolls back a quota failure during the atomic replacement', async () => {
    const { store, fetcher } = setup()
    fetcher.mockResolvedValueOnce(new Response(oldBytes))
    await store.ensure(spec(oldBytes, 'old'))
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    expect(await store.ensure(spec())).toBeNull()
    put.mockRestore()
    expect(store.getSnapshot().error).toContain('Недостаточно места')
    expect(await (await store.read())?.blob.text()).toBe(oldBytes)
  })

  it('skips automatic transfer with data saver but permits an explicit download', async () => {
    const { store, fetcher } = setup({ saveData: () => true })
    expect(await store.ensure(spec())).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    expect(store.getSnapshot().status).toBe('idle')
    expect(await (await store.ensure(spec(), { manual: true }))?.text()).toBe(newBytes)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not try a network download while offline even for a manual request', async () => {
    const { store, fetcher } = setup({ online: () => false })
    expect(await store.ensure(spec(), { manual: true })).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('cancels a pending download without replacing the previous archive or retrying automatically', async () => {
    let release!: (response: Response) => void
    const { store, fetcher } = setup()
    fetcher.mockResolvedValueOnce(new Response(oldBytes))
    await store.ensure(spec(oldBytes, 'old'))
    fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = store.ensure(spec())
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    store.cancel()
    release(new Response(newBytes))
    expect(await pending).toBeNull()
    expect(store.getSnapshot().status).toBe('idle')
    expect(await (await store.read())?.blob.text()).toBe(oldBytes)
    await store.ensure(spec())
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('reports partial progress without claiming readiness before commit', async () => {
    let finish!: () => void
    const { store, fetcher } = setup()
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(newBytes.slice(0, 4)))
        finish = () => { controller.enqueue(new TextEncoder().encode(newBytes.slice(4))); controller.close() }
      },
    })))
    const pending = store.ensure(spec())
    await vi.waitFor(() => expect(store.getSnapshot().downloadedBytes).toBe(4))
    expect(store.getSnapshot()).toMatchObject({ status: 'downloading', progress: 4 / spec().bytes * 100 })
    expect(await store.read()).toBeNull()
    finish()
    await pending
    expect(store.getSnapshot().status).toBe('ready')
  })

  it('cancels a stalled response body promptly and releases its reader', async () => {
    const cancelled = vi.fn()
    const { store, fetcher } = setup()
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(newBytes.slice(0, 4))) },
      cancel: cancelled,
    })))
    const pending = store.ensure(spec())
    await vi.waitFor(() => expect(store.getSnapshot().downloadedBytes).toBe(4))
    store.cancel()
    expect(await pending).toBeNull()
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(await store.read()).toBeNull()
  })

  it('does not let a superseded version overwrite a newer successful download', async () => {
    let release!: (response: Response) => void
    const { store, fetcher } = setup()
    fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const obsolete = store.ensure(spec(oldBytes, 'old'))
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    expect(await (await store.ensure(spec()))?.text()).toBe(newBytes)
    release(new Response(oldBytes))
    expect(await obsolete).toBeNull()
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', cachedVersion: spec().version })
    expect(await (await store.read())?.blob.text()).toBe(newBytes)
  })

  it('rejects oversized manifests and cross-origin downloads before a request', async () => {
    const { store, fetcher } = setup()
    await store.ensure({ ...spec(), bytes: MAX_CITY_ARCHIVE_BYTES + 1 })
    await store.ensure({ ...spec(), version: 'bad-url', url: 'https://other.example/map.pmtiles' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(store.getSnapshot().status).toBe('error')
  })

  it('rejects response lengths exceeding the manifest and retains no partial archive', async () => {
    const { store, fetcher } = setup()
    fetcher.mockResolvedValueOnce(new Response(newBytes + 'extra'))
    expect(await store.ensure(spec())).toBeNull()
    expect(await store.read()).toBeNull()
    expect(store.getSnapshot().status).toBe('error')
  })

  it('can save when estimate and persistence permission are unavailable', async () => {
    const storage = { estimate: vi.fn().mockRejectedValue(new Error('Denied')), persist: vi.fn().mockRejectedValue(new Error('Denied')) }
    const { store } = setup({ storage })
    expect(await (await store.ensure(spec()))?.text()).toBe(newBytes)
    expect(store.getSnapshot().status).toBe('ready')
  })
})
