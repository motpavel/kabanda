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

export type YandexPlacemark = {
  events: YandexEventManager
  properties: YandexDataManager
  options: YandexOptionManager
}

export type YandexMap = {
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
  setCenter: (center: YandexCoordinates, zoom?: number, options?: {
    duration?: number
    timingFunction?: string
  }) => void
  setZoom: (zoom: number, options?: { duration?: number }) => void
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

  runtimePromise = new Promise<YandexMapsRuntime>((resolve, reject) => {
    const finish = () => {
      const runtime = window.ymaps
      if (!runtime) {
        runtimePromise = null
        reject(new Error('Yandex Maps API did not initialize'))
        return
      }
      runtime.ready(() => resolve(runtime), (error) => {
        runtimePromise = null
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
        runtimePromise = null
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
      runtimePromise = null
      script.remove()
      reject(new Error('Failed to load Yandex Maps API'))
    }, { once: true })
    document.head.append(script)
  })

  return runtimePromise
}
