/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=', 'base64')
const tile = '/_yandex_tiles/v1/14/10613/5046.png?scale=2&map=test'
const origin = 'https://kabanda.example'
const image = () => new Response(png, { headers: { 'content-type': 'image/png' } })

function worker(fetcher = vi.fn(async (_url: unknown, _options?: unknown) => image()), idb = new IDBFactory(), key = 'synthetic-key') {
  const listeners = new Map<string, (event: any) => void>()
  const messages: unknown[] = []
  const scope = {
    KABANDA_YANDEX_TILES: { key }, registration: { scope: origin + '/' }, location: { origin },
    addEventListener: (type: string, handler: (event: any) => void) => listeners.set(type, handler),
    clients: { get: async () => ({ postMessage: (message: unknown) => messages.push(message) }) },
  }
  runInNewContext(source, { self: scope, indexedDB: idb, IDBKeyRange, fetch: fetcher, URL, Response, Blob, Uint8Array, AbortController, setTimeout, clearTimeout, Date, Promise, performance })
  const get = (path = tile, method = 'GET') => {
    let response: Promise<Response> | undefined
    listeners.get('fetch')?.({ request: new Request(new URL(path, origin), { method }), clientId: 'client', respondWith: (value: Promise<Response>) => { response = value } })
    return response
  }
  return { get, fetcher, messages, idb }
}

async function inspect(idb: IDBFactory) {
  return new Promise<{ db: IDBDatabase; rows: any[]; bytes: number }>((resolve, reject) => {
    const open = idb.open('kabanda-yandex-tiles-v1', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction(['tiles', 'meta'])
      const rows = tx.objectStore('tiles').getAll(), size = tx.objectStore('meta').get('bytes')
      tx.oncomplete = () => resolve({ db, rows: rows.result, bytes: size.result ?? 0 })
    }
  })
}

describe('official Yandex tile worker', () => {
  it('persists a validated image across worker restarts without another upstream request', async () => {
    const w = worker()
    const first = await w.get()!
    expect(first.headers.get('X-Kabanda-Tile')).toBe('miss')
    expect(Buffer.from(await first.arrayBuffer())).toEqual(png)
    const restarted = worker(w.fetcher, w.idb)
    const second = await restarted.get(tile.replace('map=test', 'map=other-map'))!
    expect(second.headers.get('X-Kabanda-Tile')).toBe('hit')
    expect(w.fetcher).toHaveBeenCalledTimes(1)
    const url = new URL(String(w.fetcher.mock.calls[0]![0]))
    expect(url.origin).toBe('https://tiles.api-maps.yandex.ru')
    expect(url.searchParams.get('projection')).toBe('wgs84_mercator')
    expect(url.searchParams.get('scale')).toBe('2')
    expect(url.searchParams.has('map')).toBe(false)
  })

  it('coalesces simultaneous foreground and speculative requests', async () => {
    const w = worker()
    const responses = await Promise.all([w.get(), w.get(tile + '&warm=1'), w.get()])
    expect(responses.every(response => response?.ok)).toBe(true)
    expect(w.fetcher).toHaveBeenCalledTimes(1)
    const state = await inspect(w.idb)
    expect(state.rows).toHaveLength(1)
    expect(state.bytes).toBe(png.length)
    state.db.close()
  })

  it.each([401, 403, 429, 500])('does not cache status %i and tells the map to fall back', async status => {
    const w = worker(vi.fn(async () => new Response('error', { status })))
    expect((await w.get()!)?.status).toBe(503)
    expect(w.messages).toEqual([{ type: 'KABANDA_YANDEX_TILE_FAILURE', mapId: 'test' }])
    const state = await inspect(w.idb)
    expect(state.rows).toHaveLength(0)
    state.db.close()
    await w.get(tile.replace('/5046.', '/5047.'))
    expect(w.fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects mislabeled HTML and never intercepts private API requests', async () => {
    const w = worker(vi.fn(async () => new Response('<html>error</html>', { headers: { 'content-type': 'image/png' } })))
    expect((await w.get()!)?.status).toBe(503)
    expect(w.get('/api/me')).toBeUndefined()
    expect(w.get('https://untrusted.example' + tile)).toBeUndefined()
    expect((await w.get('/_yandex_tiles/v1/30/1/2.png')!)?.status).toBe(400)
    expect((await w.get(tile, 'POST')!)?.status).toBe(400)
    expect(w.fetcher).toHaveBeenCalledTimes(1)
  })

  it('expires images instead of treating a recent read as a new download', async () => {
    const w = worker()
    await w.get()
    const state = await inspect(w.idb)
    await new Promise<void>(resolve => {
      const tx = state.db.transaction('tiles', 'readwrite')
      tx.objectStore('tiles').put({ ...state.rows[0], created: Date.now() - 8 * 86400000 })
      tx.oncomplete = () => resolve()
    })
    state.db.close()
    const restarted = worker(w.fetcher, w.idb)
    expect((await restarted.get()!)?.headers.get('X-Kabanda-Tile')).toBe('miss')
    expect(w.fetcher).toHaveBeenCalledTimes(2)
  })

  it('evicts least-recently-used public images when the byte budget is exceeded', async () => {
    const w = worker()
    await w.get()
    const state = await inspect(w.idb)
    await new Promise<void>(resolve => {
      const tx = state.db.transaction(['tiles', 'meta'], 'readwrite')
      tx.objectStore('tiles').put({ ...state.rows[0], key: 'old', bytes: 100 * 1024 * 1024, used: 1 })
      tx.objectStore('meta').put(100 * 1024 * 1024 + png.length, 'bytes')
      tx.oncomplete = () => resolve()
    })
    state.db.close()
    await w.get(tile.replace('/5046.', '/5047.'))
    const after = await inspect(w.idb)
    expect(after.rows.map(row => row.key)).not.toContain('old')
    expect(after.bytes).toBe(png.length * 2)
    after.db.close()
  })

  it('does not install any handlers without a separate Tiles API key', () => {
    const w = worker(undefined, undefined, '')
    expect(w.get()).toBeUndefined()
    expect(w.fetcher).not.toHaveBeenCalled()
  })
})
