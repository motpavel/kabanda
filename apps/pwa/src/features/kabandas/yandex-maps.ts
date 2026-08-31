export type YandexCoordinates = readonly [number, number]

type YandexEvent = {
  get: (name: string) => unknown
  stopPropagation?: () => void
}

type YandexEventManager = {
  add: (name: string, handler: (event: YandexEvent) => void) => void
}

type YandexDataManager = {
  set: (name: string, value: unknown) => void
}

type YandexOptionManager = {
  set: (name: string, value: unknown) => void
}

export type YandexPlacemark = {
  events: YandexEventManager
  properties: YandexDataManager
  options: YandexOptionManager
}

export type YandexMap = {
  events: YandexEventManager
  geoObjects: {
    add: (object: YandexPlacemark) => void
    remove: (object: YandexPlacemark) => void
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
