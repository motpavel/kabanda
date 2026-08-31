export type YandexCoordinates = readonly [number, number]

export type YandexMapEntity = object

export type YandexMapLocation = {
  center?: YandexCoordinates
  zoom?: number
  duration?: number
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'
}

export type YandexMap = {
  addChild: (entity: YandexMapEntity) => YandexMap
  removeChild: (entity: YandexMapEntity) => YandexMap
  update: (props: { location?: YandexMapLocation }) => void
  destroy: () => void
}

type YandexMapUpdate = {
  location?: {
    center: YandexCoordinates
    zoom: number
  }
}

export type YandexMapsRuntime = {
  ready: Promise<void>
  YMap: new (element: HTMLElement, props: {
    location: { center: YandexCoordinates; zoom: number }
    behaviors?: readonly string[]
    mode?: 'raster' | 'vector'
    zoomRange?: { min: number; max: number }
    zoomRounding?: 'smooth'
  }) => YandexMap
  YMapDefaultSchemeLayer: new (props?: {
    customization?: readonly {
      tags: { any: readonly string[] }
      elements: string
      stylers: readonly { visibility: 'off' | 'on' }[]
    }[]
  }) => YandexMapEntity
  YMapDefaultFeaturesLayer: new (props?: { zIndex?: number }) => YandexMapEntity
  YMapMarker: new (props: {
    coordinates: YandexCoordinates
    zIndex?: number
    blockEvents?: boolean
    blockBehaviors?: boolean
  }, element?: HTMLElement) => YandexMapEntity
  YMapListener: new (props: {
    layer: 'any'
    onUpdate: (update: YandexMapUpdate) => void
  }) => YandexMapEntity
}

declare global {
  interface Window {
    ymaps3?: YandexMapsRuntime
  }
}

let runtimePromise: Promise<YandexMapsRuntime> | null = null

export function yandexMapsApiUrl(apiKey: string) {
  const url = new URL('https://api-maps.yandex.ru/v3/')
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
      const runtime = window.ymaps3
      if (!runtime) {
        runtimePromise = null
        reject(new Error('Yandex Maps API did not initialize'))
        return
      }
      runtime.ready.then(() => resolve(runtime)).catch((error: unknown) => {
        runtimePromise = null
        reject(error)
      })
    }

    if (window.ymaps3) {
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
