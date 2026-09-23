import type { YandexMap, YandexMapsRuntime } from '../yandex-maps'
import { nearbyTiles, tileAt, tilePath } from './coordinates'

function workerAvailable(): Promise<boolean> {
  const controller = navigator.serviceWorker?.controller
  if (!controller) return Promise.resolve(false)
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const finish = (enabled: boolean) => { clearTimeout(timer); channel.port1.close(); resolve(enabled) }
    const timer = setTimeout(() => finish(false), 2500)
    channel.port1.onmessage = event => finish(event.data?.version === 1 && event.data?.enabled === true)
    controller.postMessage({ type: 'KABANDA_YANDEX_TILES_STATUS' }, [channel.port2])
  })
}

/** Opt-in official Yandex raster layer. The regular map stays visible until a
 * real, readable API image has passed through the installed cache worker. */
export function attachYandexTileCache(map: YandexMap, runtime: YandexMapsRuntime, container: HTMLElement): () => void {
  if (typeof __YANDEX_TILES_ENABLED__ === 'undefined' || !__YANDEX_TILES_ENABLED__ || !('serviceWorker' in navigator) || !map.setType || !runtime.Layer || !runtime.MapType || !runtime.vow) return () => {}
  const mapId = crypto.randomUUID()
  const base = import.meta.env.BASE_URL
  const scale = window.devicePixelRatio > 1 ? 2 : 1
  const Layer = runtime.Layer, MapType = runtime.MapType, vow = runtime.vow
  let disposed = false, enabled = false, enabling = false, retryAfter = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let warmup: AbortController | undefined, probe: AbortController | undefined
  const visible = () => !disposed && document.visibilityState === 'visible' && container.getBoundingClientRect().width > 0 && container.getBoundingClientRect().height > 0
  const stopWarmup = () => { clearTimeout(timer); warmup?.abort(); warmup = undefined }
  const fallback = () => {
    retryAfter = Date.now() + 60_000
    stopWarmup()
    if (!enabled || disposed) return
    enabled = false
    void Promise.resolve(map.setType!('yandex#map')).catch(() => {})
  }
  const schedule = () => {
    stopWarmup()
    if (!visible()) return
    if (!enabled) { void enable(); return }
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
    if (!navigator.onLine || connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return
    timer = setTimeout(() => {
      if (!visible() || !enabled) return
      const controller = new AbortController(); warmup = controller
      const rect = container.getBoundingClientRect()
      const tiles = nearbyTiles(map.getCenter(), map.getZoom(), rect.width, rect.height)
      void (async () => {
        for (const tile of tiles) {
          if (controller.signal.aborted || !visible()) return
          try {
            const response = await fetch(`${tilePath(tile, scale, mapId, base)}&warm=1`, { signal: controller.signal, cache: 'no-store' })
            if (!response.ok) return
            await response.arrayBuffer()
          } catch { return }
        }
      })()
    }, 900)
  }
  const enable = async () => {
    if (disposed || enabled || enabling || !visible() || Date.now() < retryAfter) return
    enabling = true
    retryAfter = Date.now() + 60_000
    try {
      if (!await workerAvailable() || !visible()) return
      const controller = new AbortController(); probe = controller
      const timeout = setTimeout(() => controller.abort(), 10_000)
      try {
        const response = await fetch(tilePath(tileAt(map.getCenter(), map.getZoom()), scale, mapId, base), { signal: controller.signal, cache: 'no-store' })
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) return
        await response.arrayBuffer()
      } finally { clearTimeout(timeout) }
      if (!visible()) return
      const layer = new Layer((number, zoom) => tilePath({ x: number[0], y: number[1], z: zoom }, scale, mapId, base), { tileSize: [256, 256] })
      layer.getCopyrights = () => vow.resolve('<a href="https://yandex.ru/maps/" target="_blank" rel="noopener">© Яндекс</a>')
      layer.getZoomRange = () => vow.resolve([0, 20])
      const type = new MapType('Яндекс', [function () { return layer }])
      enabled = true
      await map.setType!(type)
      schedule()
    } catch { fallback() }
    finally { enabling = false }
  }
  const message = (event: MessageEvent) => {
    if (event.data?.type === 'KABANDA_YANDEX_TILE_FAILURE' && event.data.mapId === mapId) fallback()
  }
  const resume = () => { retryAfter = 0; schedule() }
  const controllerChanged = () => { fallback(); resume() }
  const resize = new ResizeObserver(schedule)
  resize.observe(container)
  map.events.add('boundschange', schedule)
  navigator.serviceWorker.addEventListener('message', message)
  navigator.serviceWorker.addEventListener('controllerchange', controllerChanged)
  window.addEventListener('online', resume)
  document.addEventListener('visibilitychange', schedule)
  schedule()
  return () => {
    disposed = true; stopWarmup(); probe?.abort(); resize.disconnect()
    map.events.remove?.('boundschange', schedule)
    navigator.serviceWorker.removeEventListener('message', message)
    navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged)
    window.removeEventListener('online', resume)
    document.removeEventListener('visibilitychange', schedule)
  }
}
