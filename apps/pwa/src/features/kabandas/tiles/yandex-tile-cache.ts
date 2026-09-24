import type { YandexMap, YandexMapsRuntime } from '../yandex-maps'
import { mapDiagnostics } from './map-diagnostics'
import { DecodedTiles } from './decoded-tiles'
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
  const diagnostic = mapDiagnostics(map, container)
  if (typeof __YANDEX_TILES_ENABLED__ === 'undefined' || !__YANDEX_TILES_ENABLED__ || !('serviceWorker' in navigator) || !map.setType || !runtime.Layer || !runtime.MapType || !runtime.vow) { diagnostic.state('Обычный Яндекс, кэш не настроен'); return diagnostic.dispose }
  const decoded = new DecodedTiles()
  const requested = new Set<string>()
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
    diagnostic.state('Обычный Яндекс: резерв после ошибки')
    retryAfter = Date.now() + 60_000
    stopWarmup()
    decoded.clear(); requested.clear()
    if (!enabled || disposed) return
    enabled = false
    void Promise.resolve(map.setType!('yandex#map')).catch(() => {})
  }
  const schedule = () => {
    stopWarmup()
    if (!visible()) { decoded.clear(); return }
    if (!enabled) { void enable(); return }
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
    if (!navigator.onLine || connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return
    timer = setTimeout(() => {
      if (!visible() || !enabled) return
      const controller = new AbortController(); warmup = controller
      const rect = container.getBoundingClientRect()
      const tiles = nearbyTiles(map.getCenter(), map.getZoom(), rect.width, rect.height)
      void (async () => {
        // Prepare recently displayed fragments first, then the small edge
        // reserve. The current SDK frame is never invalidated or repainted.
        const paths = [...requested].slice(-16)
        paths.push(...tiles.slice(0, 4).map(tile => tilePath(tile, scale, mapId, base)))
        for (const path of new Set(paths)) {
          if (controller.signal.aborted || !visible()) return
          try {
            await decoded.prepare(path, controller.signal)
            if (!controller.signal.aborted) requested.delete(path)
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
      if (!await workerAvailable() || !visible()) { diagnostic.state('Обычный Яндекс: SW недоступен'); return }
      const controller = new AbortController(); probe = controller
      const timeout = setTimeout(() => controller.abort(), 10_000)
      try {
        const response = await fetch(tilePath(tileAt(map.getCenter(), map.getZoom()), scale, mapId, base), { signal: controller.signal, cache: 'no-store' })
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) { diagnostic.state(`Обычный Яндекс: проверка ${response.status}`); return }
        await response.arrayBuffer()
      } finally { clearTimeout(timeout) }
      if (!visible()) return
      const layer = new Layer((number, zoom) => {
        const path = tilePath({ x: number[0], y: number[1], z: zoom }, scale, mapId, base)
        requested.delete(path); requested.add(path)
        if (requested.size > 32) requested.delete(requested.values().next().value!)
        const url = decoded.url(path)
        diagnostic.request(url !== path)
        return diagnostic.active() && url === path ? `${path}&debug=1` : url
      }, { tileSize: [256, 256], loadTilesInAction: true })
      layer.getCopyrights = () => vow.resolve('<a href="https://yandex.ru/maps/" target="_blank" rel="noopener">© Яндекс</a>')
      layer.getZoomRange = () => vow.resolve([0, 20])
      const type = new MapType('Яндекс', [function () { return layer }])
      diagnostic.layer(layer)
      enabled = true
      await map.setType!(type)
      diagnostic.state('Tiles API + локальный кэш')
      schedule()
    } catch { fallback() }
    finally { enabling = false }
  }
  const message = (event: MessageEvent) => {
    if (event.data?.type === 'KABANDA_TILE_TIMING' && event.data.mapId === mapId) diagnostic.response(event.data.source, event.data.ms)
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
    diagnostic.dispose(); disposed = true; stopWarmup(); decoded.dispose(); requested.clear(); probe?.abort(); resize.disconnect()
    map.events.remove?.('boundschange', schedule)
    navigator.serviceWorker.removeEventListener('message', message)
    navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged)
    window.removeEventListener('online', resume)
    document.removeEventListener('visibilitychange', schedule)
  }
}
