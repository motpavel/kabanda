import { useEffect, useRef, useState } from 'react'
import { loadYandexMaps, type YandexMap, type YandexMapsRuntime } from '../kabandas/yandex-maps'
import { TEST_ROUTE, type RouteCoordinate } from './simulation'

type YandexGeometry = {
  setCoordinates: (coordinates: readonly RouteCoordinate[] | RouteCoordinate) => void
}

type YandexMapObject = {
  geometry: YandexGeometry
}

type PrototypeRuntime = YandexMapsRuntime & {
  Polyline: new (
    coordinates: readonly RouteCoordinate[],
    properties?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => YandexMapObject
}

type PrototypeMap = Omit<YandexMap, 'geoObjects'> & {
  geoObjects: {
    add: (object: unknown) => void
    remove: (object: unknown) => void
  }
}

type MovingPlacemark = YandexMapObject

export function RouteSimulationMap({
  showSamples,
  traveled,
}: {
  showSamples?: boolean
  traveled: readonly RouteCoordinate[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<PrototypeMap | null>(null)
  const runtimeRef = useRef<PrototypeRuntime | null>(null)
  const actualLineRef = useRef<YandexMapObject | null>(null)
  const actualCasingRef = useRef<YandexMapObject | null>(null)
  const riderRef = useRef<MovingPlacemark | null>(null)
  const samplesRef = useRef<unknown[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let active = true
    const apiKey = import.meta.env.VITE_YANDEX_MAPS_API_KEY?.trim() ?? ''

    void loadYandexMaps(apiKey).then((baseRuntime) => {
      if (!active) return
      const runtime = baseRuntime as PrototypeRuntime
      const map = new runtime.Map(container, {
        center: [56.85355, 53.2127],
        zoom: 15,
        controls: [],
        behaviors: ['default', 'scrollZoom'],
        type: 'yandex#map',
      }, { suppressMapOpenBlock: true }) as PrototypeMap

      const plannedCasing = new runtime.Polyline(TEST_ROUTE, {}, {
        strokeColor: '#ffffff',
        strokeWidth: 8,
        strokeOpacity: 0.9,
        strokeStyle: 'shortdash',
      })
      const plannedLine = new runtime.Polyline(TEST_ROUTE, {}, {
        strokeColor: '#8b9095',
        strokeWidth: 4,
        strokeOpacity: 0.72,
        strokeStyle: 'shortdash',
      })
      const actualCasing = new runtime.Polyline([TEST_ROUTE[0]!], {}, {
        strokeColor: '#ffffff',
        strokeWidth: 9,
        strokeOpacity: 0.96,
      })
      const actualLine = new runtime.Polyline([TEST_ROUTE[0]!], {}, {
        strokeColor: '#17191b',
        strokeWidth: 5,
        strokeOpacity: 1,
      })
      const riderLayout = runtime.templateLayoutFactory.createClass(
        `<span class="route-proto-rider" aria-label="Навигатор рейда"><img src="${import.meta.env.BASE_URL}brand/kabanda-logo-reference.png" alt="" /></span>`,
      )
      const rider = new runtime.Placemark(TEST_ROUTE[0]!, {}, {
        iconLayout: riderLayout,
        iconShape: { type: 'Circle', coordinates: [0, 0], radius: 24 },
        hasBalloon: false,
        hasHint: false,
        zIndex: 8,
      }) as unknown as MovingPlacemark
      const destinationLayout = runtime.templateLayoutFactory.createClass(
        '<span class="route-proto-destination" aria-label="Следующая точка"><span></span></span>',
      )
      const destination = new runtime.Placemark(TEST_ROUTE.at(-1)!, {}, {
        iconLayout: destinationLayout,
        iconShape: { type: 'Circle', coordinates: [0, 0], radius: 18 },
        hasBalloon: false,
        hasHint: false,
        zIndex: 7,
      })

      map.geoObjects.add(plannedCasing)
      map.geoObjects.add(plannedLine)
      map.geoObjects.add(actualCasing)
      map.geoObjects.add(actualLine)
      map.geoObjects.add(destination)
      map.geoObjects.add(rider)
      mapRef.current = map
      runtimeRef.current = runtime
      actualLineRef.current = actualLine
      actualCasingRef.current = actualCasing
      riderRef.current = rider
      setStatus('ready')
    }).catch(() => {
      if (active) setStatus('failed')
    })

    return () => {
      active = false
      mapRef.current?.destroy()
      mapRef.current = null
      runtimeRef.current = null
      actualLineRef.current = null
      actualCasingRef.current = null
      riderRef.current = null
      samplesRef.current = []
    }
  }, [])

  useEffect(() => {
    if (status !== 'ready' || !traveled.length) return
    actualLineRef.current?.geometry.setCoordinates(traveled)
    actualCasingRef.current?.geometry.setCoordinates(traveled)
    riderRef.current?.geometry.setCoordinates(traveled.at(-1)!)

    const map = mapRef.current
    const runtime = runtimeRef.current
    if (!map || !runtime) return
    for (const sample of samplesRef.current) map.geoObjects.remove(sample)
    samplesRef.current = []
    if (!showSamples) return
    const sampleLayout = runtime.templateLayoutFactory.createClass('<span class="route-proto-sample"></span>')
    for (const coordinate of traveled.slice(0, -1)) {
      const sample = new runtime.Placemark(coordinate, {}, {
        iconLayout: sampleLayout,
        iconShape: { type: 'Circle', coordinates: [0, 0], radius: 3 },
        zIndex: 6,
      })
      samplesRef.current.push(sample)
      map.geoObjects.add(sample)
    }
  }, [showSamples, status, traveled])

  return (
    <div className="route-proto-map-wrap">
      <div ref={containerRef} className="route-proto-map" aria-label="Симуляция маршрута рейда" />
      {status === 'loading' ? <p className="route-proto-map-state">Загружаем карту…</p> : null}
      {status === 'failed' ? <p className="route-proto-map-state route-proto-map-state--error">Карта не загрузилась. Проверьте локальный API-ключ Яндекса.</p> : null}
      <div className="route-proto-legend" aria-label="Обозначения маршрута">
        <span><i className="route-proto-legend__actual" />Проехали</span>
        <span><i className="route-proto-legend__planned" />Осталось</span>
      </div>
    </div>
  )
}
