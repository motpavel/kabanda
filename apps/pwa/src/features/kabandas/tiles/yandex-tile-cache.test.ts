import { afterEach, describe, expect, it, vi } from 'vitest'
import type { YandexMap, YandexMapsRuntime } from '../yandex-maps'
import { attachYandexTileCache } from './yandex-tile-cache'

function fixture() {
  const sw = Object.assign(new EventTarget(), { controller: { postMessage: (_data: unknown, ports: MessagePort[]) => ports[0]!.postMessage({ version: 1, enabled: true }) } })
  vi.stubGlobal('__YANDEX_TILES_ENABLED__', true)
  vi.stubGlobal('navigator', { serviceWorker: sw, onLine: true, connection: { saveData: true } })
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  vi.stubGlobal('window', Object.assign(new EventTarget(), { devicePixelRatio: 2 }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const fetcher = vi.fn(async () => new Response('validated worker image', { headers: { 'content-type': 'image/png' } }))
  vi.stubGlobal('fetch', fetcher)
  const handlers = new Map<string, () => void>()
  const setType = vi.fn(async (_type: unknown) => {})
  const map = { setType, getCenter: () => [56.8528, 53.2045], getZoom: () => 14,
    events: { add: (name: string, callback: () => void) => handlers.set(name, callback), remove: (name: string) => handlers.delete(name) } } as unknown as YandexMap
  class Layer { constructor(public url: (number: [number, number], zoom: number) => string) {} }
  class MapType { constructor(public name: string, public layers: (() => Layer)[]) {} getName() { return this.name } }
  const runtime = { Layer, MapType, vow: { resolve: (value: unknown) => Promise.resolve(value) } } as unknown as YandexMapsRuntime
  const container = { getBoundingClientRect: () => ({ width: 390, height: 844 }) } as HTMLElement
  return { sw, fetcher, map, runtime, container, setType, handlers }
}
afterEach(() => vi.unstubAllGlobals())

describe('cached Yandex layer activation', () => {
  it('switches only after a successful worker probe, preserves the map, and falls back on tile failure', async () => {
    const f = fixture()
    const stop = attachYandexTileCache(f.map, f.runtime, f.container)
    try {
      await vi.waitFor(() => expect(f.setType).toHaveBeenCalledTimes(1))
      const type = f.setType.mock.calls[0]![0] as { layers: (() => { url: (xy: [number, number], z: number) => string })[] }
      const tile = new URL(type.layers[0]!().url([10613, 5046], 14), 'https://test.example')
      expect(tile.pathname).toBe('/_yandex_tiles/v1/14/10613/5046.png')
      expect(tile.searchParams.get('scale')).toBe('2')
      f.sw.dispatchEvent(new MessageEvent('message', { data: { type: 'KABANDA_YANDEX_TILE_FAILURE', mapId: tile.searchParams.get('map') } }))
      expect(f.setType).toHaveBeenLastCalledWith('yandex#map')
      f.handlers.get('boundschange')?.()
      expect(f.fetcher).toHaveBeenCalledTimes(1)
    } finally { stop() }
    expect(f.handlers.size).toBe(0)
  })

  it('leaves the ordinary map unchanged on a denied API probe', async () => {
    const f = fixture()
    f.fetcher.mockImplementation(async () => new Response('', { status: 503 }))
    const stop = attachYandexTileCache(f.map, f.runtime, f.container)
    try {
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1))
      expect(f.setType).not.toHaveBeenCalled()
    } finally { stop() }
  })

  it('does not switch or prefetch after the map has been disposed', async () => {
    const f = fixture()
    let complete!: (response: Response) => void
    f.fetcher.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const stop = attachYandexTileCache(f.map, f.runtime, f.container)
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1))
    stop()
    complete(new Response('image', { headers: { 'content-type': 'image/png' } }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.setType).not.toHaveBeenCalled()
  })

  it('does nothing when the optional API is not configured', () => {
    const f = fixture()
    vi.stubGlobal('__YANDEX_TILES_ENABLED__', false)
    attachYandexTileCache(f.map, f.runtime, f.container)()
    expect(f.fetcher).not.toHaveBeenCalled()
    expect(f.handlers.size).toBe(0)
  })
})
