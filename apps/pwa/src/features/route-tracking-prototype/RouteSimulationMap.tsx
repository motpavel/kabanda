import { useEffect, useRef, useState } from 'react'
import { loadYandexMaps, type YandexMap, type YandexMapsRuntime } from '../kabandas/yandex-maps'
import { ROUTE_START, type RouteCoordinate } from './simulation'

type YandexGeometry = {
  getCoordinates?: () => unknown
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

export function RouteSimulationMap({
  current,
  traveled,
}: {
  current: RouteCoordinate | null
  traveled: readonly RouteCoordinate[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<PrototypeMap | null>(null)
  const actualLineRef = useRef<YandexMapObject | null>(null)
  const actualCasingRef = useRef<YandexMapObject | null>(null)
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
        center: ROUTE_START,
        zoom: 17,
        controls: [],
        behaviors: ['default', 'scrollZoom'],
        type: 'yandex#map',
      }, { suppressMapOpenBlock: true }) as PrototypeMap

      const actualCasing = new runtime.Polyline([ROUTE_START], {}, {
        strokeColor: '#ffffff',
        strokeWidth: 9,
        strokeOpacity: 0.96,
      })
      const actualLine = new runtime.Polyline([ROUTE_START], {}, {
        strokeColor: '#17191b',
        strokeWidth: 5,
        strokeOpacity: 1,
      })
      map.geoObjects.add(actualCasing)
      map.geoObjects.add(actualLine)

      mapRef.current = map
      actualLineRef.current = actualLine
      actualCasingRef.current = actualCasing
      setStatus('ready')
    }).catch(() => {
      if (active) setStatus('failed')
    })

    return () => {
      active = false
      mapRef.current?.destroy()
      mapRef.current = null
      actualLineRef.current = null
      actualCasingRef.current = null
    }
  }, [])

  useEffect(() => {
    if (status !== 'ready' || !traveled.length || !current) return
    actualLineRef.current?.geometry.setCoordinates(traveled)
    actualCasingRef.current?.geometry.setCoordinates(traveled)
    mapRef.current?.setCenter(current, 17, {
      duration: 560,
      timingFunction: 'ease-out',
    })
  }, [current, status, traveled])

  return (
    <div className="route-proto-map-wrap">
      <div ref={containerRef} className="route-proto-map" aria-label="Симуляция маршрута рейда" />
      {status === 'ready' ? (
        <span className="route-proto-rider" aria-label="Положение организатора рейда">
          <img src={`${import.meta.env.BASE_URL}brand/kabanda-logo-reference.png`} alt="" />
        </span>
      ) : null}
      {status === 'loading' ? <p className="route-proto-map-state">Загружаем карту…</p> : null}
      {status === 'failed' ? <p className="route-proto-map-state route-proto-map-state--error">Не удалось загрузить карту.</p> : null}
    </div>
  )
}
