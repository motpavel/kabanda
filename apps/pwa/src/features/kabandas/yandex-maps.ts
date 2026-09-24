/** JavaScript API 2.1 boundary order: [latitude, longitude]. */
export type YandexCoordinates = readonly [number, number]

export type YandexEvent = {
  get: <Value = unknown>(name: string) => Value
  stopPropagation?: () => void
}

export type YandexEventHandler = (event: YandexEvent) => void

export type YandexEventManager = {
  add: (name: string, handler: YandexEventHandler) => void
  remove?: (name: string, handler: YandexEventHandler) => void
}

export type YandexDataManager = {
  get: <Value = unknown>(name: string) => Value
  set: (name: string, value: unknown) => void
}

export type YandexOptionManager = {
  set: (name: string, value: unknown) => void
}

export type YandexMapObject = object
export type YandexTileLayer = {
  events?: YandexEventManager
  getTileStatus?: () => { readyTileNumber: number; totalTileNumber: number }
  getCopyrights?: () => PromiseLike<unknown>
  getZoomRange?: () => PromiseLike<unknown>
}
export type YandexMapType = { getName: () => string }

export type YandexPlacemark = {
  geometry?: { setCoordinates: (coordinates: YandexCoordinates) => void }
  events: YandexEventManager
  properties: YandexDataManager
  options: YandexOptionManager
}

export type YandexMap = {
  setType?: (type: string | YandexMapType) => PromiseLike<void> | void
  container?: {
    fitToViewport?: () => void
  }
  events: YandexEventManager
  geoObjects: {
    add: (object: YandexMapObject) => void
    remove: (object: YandexMapObject) => void
  }
  getCenter: () => YandexCoordinates
  getZoom: () => number
  panTo: (center: YandexCoordinates, options?: { duration?: number; flying?: boolean; safe?: boolean; timingFunction?: string }) => PromiseLike<void> | void
  setCenter: (center: YandexCoordinates, zoom?: number, options?: {
    duration?: number
    timingFunction?: string
  }) => PromiseLike<void> | void
  setZoom: (zoom: number, options?: { duration?: number }) => PromiseLike<void> | void
  destroy: () => void
}

export type YandexPolyline = {
  geometry: {
    getCoordinates?: () => unknown
    setCoordinates: (coordinates: readonly YandexCoordinates[] | YandexCoordinates) => void
  }
  editor?: {
    startEditing: () => void
    stopEditing: () => void
  }
}

export type YandexMultiRouteRoute = {
  properties: YandexDataManager
}

export type YandexMultiRoute = {
  model: {
    events: YandexEventManager
  }
  getActiveRoute: () => YandexMultiRouteRoute | null
}

export type YandexMapsRuntime = {
  Layer?: new (url: (number: readonly [number, number], zoom: number) => string, options?: Record<string, unknown>) => YandexTileLayer
  MapType?: new (name: string, layers: (() => YandexTileLayer)[]) => YandexMapType
  vow?: { resolve: (value: unknown) => PromiseLike<unknown> }
  ready: (success: () => void, error?: (reason: unknown) => void) => void
  Map: new (element: HTMLElement, state: {
    center: YandexCoordinates
    zoom: number
    controls?: readonly string[]
    behaviors?: readonly string[]
    type?: string
  }, options?: { suppressMapOpenBlock?: boolean }) => YandexMap
  Placemark: new (coordinates: YandexCoordinates, properties?: Record<string, unknown>, options?: Record<string, unknown>) => YandexPlacemark
  Polyline: new (
    coordinates: readonly YandexCoordinates[],
    properties?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => YandexPolyline
  multiRouter: {
    MultiRoute: new (model: {
      referencePoints: readonly YandexCoordinates[]
      params?: {
        results?: number
        reverseGeocoding?: boolean
        routingMode?: 'auto' | 'masstransit' | 'pedestrian' | 'bicycle'
      }
    }, options?: Record<string, unknown>) => YandexMultiRoute
  }
  coordSystem: {
    geo: {
      getDistance: (from: YandexCoordinates, to: YandexCoordinates) => number
    }
  }
  templateLayoutFactory: {
    createClass: (template: string) => unknown
  }
}

declare global {
  interface Window {
    ymaps?: YandexMapsRuntime
  }
}

let runtimePromise: Promise<YandexMapsRuntime> | null = null

/** Warm only the shared SDK, never create a hidden map or request location.
 * Yield to the first screen and respect mobile data-saving preferences. */
export function scheduleYandexMapsWarmup(apiKey: string): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (!apiKey.trim() || runtimePromise || connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return () => {}
  let cancelled = false
  let idle: number | undefined
  const warm = () => {
    if (!cancelled && document.visibilityState === 'visible' && navigator.onLine !== false) void loadYandexMaps(apiKey).catch(() => {})
  }
  const timer = window.setTimeout(() => {
    if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(warm, { timeout: 3000 })
    else warm()
  }, 1500)
  return () => {
    cancelled = true
    window.clearTimeout(timer)
    if (idle !== undefined) window.cancelIdleCallback(idle)
  }
}

export function yandexMapsApiUrl(apiKey: string) {
  const url = new URL('https://api-maps.yandex.ru/2.1/')
  url.searchParams.set('apikey', apiKey.trim())
  url.searchParams.set('lang', 'ru_RU')
  return url.toString()
}

export function loadYandexMaps(apiKey: string) {
  const key = apiKey.trim()
  if (!key) return Promise.reject(new Error('Yandex Maps API key is not configured'))
  if (runtimePromise) return runtimePromise

  const pending = new Promise<YandexMapsRuntime>((resolve, reject) => {
    const finish = () => {
      const runtime = window.ymaps
      if (!runtime) {
        document.querySelector<HTMLScriptElement>('script[data-kabanda-yandex-maps]')?.remove()
        reject(new Error('Yandex Maps API did not initialize'))
        return
      }
      runtime.ready(() => resolve(runtime), (error) => {
        reject(error)
      })
    }

    if (window.ymaps) {
      finish()
      return
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-kabanda-yandex-maps]')
    if (existing) {
      existing.addEventListener('load', finish, { once: true })
      existing.addEventListener('error', () => {
        existing.remove()
        reject(new Error('Failed to load Yandex Maps API'))
      }, { once: true })
      return
    }

    const script = document.createElement('script')
    script.dataset.kabandaYandexMaps = 'true'
    script.src = yandexMapsApiUrl(key)
    script.async = true
    script.addEventListener('load', finish, { once: true })
    script.addEventListener('error', () => {
      script.remove()
      reject(new Error('Failed to load Yandex Maps API'))
    }, { once: true })
    document.head.append(script)
  })

  runtimePromise = pending
  // Also recover from a synchronous ready() failure during background warmup.
  // Reset after assignment so opening the map can make another attempt.
  void pending.catch(() => { if (runtimePromise === pending) runtimePromise = null })
  return pending
}
