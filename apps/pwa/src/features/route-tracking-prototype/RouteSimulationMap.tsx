import { useEffect, useRef, useState } from 'react'
import { loadYandexMaps, type YandexMap, type YandexMapsRuntime } from '../kabandas/yandex-maps'
import { ROUTE_DESTINATION, ROUTE_START, type RouteCoordinate } from './simulation'

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
  multiRouter: {
    MultiRoute: new (
      model: {
        referencePoints: readonly RouteCoordinate[]
        params: { results: number; routingMode: 'bicycle' }
      },
      options?: Record<string, unknown>,
    ) => YandexMultiRoute
  }
}

type PrototypeMap = Omit<YandexMap, 'geoObjects'> & {
  geoObjects: {
    add: (object: unknown) => void
    remove: (object: unknown) => void
  }
}

type YandexCollection<T> = {
  each: (callback: (item: T) => void) => void
}

type YandexRouteSegment = {
  geometry: { getCoordinates: () => unknown } | null
}

type YandexRoutePath = {
  getSegments: () => YandexCollection<YandexRouteSegment>
}

type YandexActiveRoute = {
  getPaths: () => YandexCollection<YandexRoutePath>
}

type YandexMultiRoute = {
  getActiveRoute: () => YandexActiveRoute | null
  model: {
    events: {
      add: (name: 'requestsuccess' | 'requestfail', callback: () => void) => void
    }
  }
}

function isRouteCoordinate(value: unknown): value is RouteCoordinate {
  return Array.isArray(value) && value.length >= 2 &&
    typeof value[0] === 'number' && Number.isFinite(value[0]) &&
    typeof value[1] === 'number' && Number.isFinite(value[1])
}

function routeCoordinates(multiRoute: YandexMultiRoute) {
  const coordinates: RouteCoordinate[] = []
  const appendCoordinates = (value: unknown) => {
    if (isRouteCoordinate(value)) {
      const previous = coordinates.at(-1)
      if (!previous || previous[0] !== value[0] || previous[1] !== value[1]) coordinates.push(value)
      return
    }
    if (Array.isArray(value)) value.forEach(appendCoordinates)
  }

  multiRoute.getActiveRoute()?.getPaths().each((path) => {
    path.getSegments().each((segment) => appendCoordinates(segment.geometry?.getCoordinates()))
  })
  return coordinates
}

export function RouteSimulationMap({
  current,
  onRouteResolved,
  onRouteStatusChange,
  remaining,
  traveled,
}: {
  current: RouteCoordinate | null
  onRouteResolved: (route: readonly RouteCoordinate[]) => void
  onRouteStatusChange: (status: 'loading' | 'ready' | 'failed') => void
  remaining: readonly RouteCoordinate[]
  traveled: readonly RouteCoordinate[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<PrototypeMap | null>(null)
  const actualLineRef = useRef<YandexMapObject | null>(null)
  const actualCasingRef = useRef<YandexMapObject | null>(null)
  const remainingLineRef = useRef<YandexMapObject | null>(null)
  const remainingCasingRef = useRef<YandexMapObject | null>(null)
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

      const plannedCasing = new runtime.Polyline([ROUTE_START], {}, {
        strokeColor: '#ffffff',
        strokeWidth: 8,
        strokeOpacity: 0.9,
        strokeStyle: 'shortdash',
      })
      const plannedLine = new runtime.Polyline([ROUTE_START], {}, {
        strokeColor: '#8b9095',
        strokeWidth: 4,
        strokeOpacity: 0.72,
        strokeStyle: 'shortdash',
      })
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
      const destinationLayout = runtime.templateLayoutFactory.createClass(
        '<span class="route-proto-destination" aria-label="Следующая точка"><span></span></span>',
      )
      const destination = new runtime.Placemark(ROUTE_DESTINATION, {}, {
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
      const multiRoute = new runtime.multiRouter.MultiRoute({
        referencePoints: [ROUTE_START, ROUTE_DESTINATION],
        params: { results: 1, routingMode: 'bicycle' },
      }, {
        routeActiveStrokeOpacity: 0,
        routeStrokeOpacity: 0,
        viaPointVisible: false,
        wayPointVisible: false,
      })
      map.geoObjects.add(multiRoute as unknown)

      multiRoute.model.events.add('requestsuccess', () => {
        if (!active) return
        const resolvedRoute = routeCoordinates(multiRoute)
        if (resolvedRoute.length < 2) {
          setStatus('failed')
          onRouteStatusChange('failed')
          return
        }
        plannedCasing.geometry.setCoordinates(resolvedRoute)
        plannedLine.geometry.setCoordinates(resolvedRoute)
        setStatus('ready')
        onRouteStatusChange('ready')
        onRouteResolved(resolvedRoute)
      })
      multiRoute.model.events.add('requestfail', () => {
        if (!active) return
        setStatus('failed')
        onRouteStatusChange('failed')
      })

      mapRef.current = map
      actualLineRef.current = actualLine
      actualCasingRef.current = actualCasing
      remainingLineRef.current = plannedLine
      remainingCasingRef.current = plannedCasing
    }).catch(() => {
      if (active) {
        setStatus('failed')
        onRouteStatusChange('failed')
      }
    })

    return () => {
      active = false
      mapRef.current?.destroy()
      mapRef.current = null
      actualLineRef.current = null
      actualCasingRef.current = null
      remainingLineRef.current = null
      remainingCasingRef.current = null
    }
  }, [onRouteResolved, onRouteStatusChange])

  useEffect(() => {
    if (status !== 'ready' || !traveled.length || !current) return
    actualLineRef.current?.geometry.setCoordinates(traveled)
    actualCasingRef.current?.geometry.setCoordinates(traveled)
    remainingLineRef.current?.geometry.setCoordinates(remaining)
    remainingCasingRef.current?.geometry.setCoordinates(remaining)
    mapRef.current?.setCenter(current, 17, {
      duration: 560,
      timingFunction: 'ease-out',
    })
  }, [current, remaining, status, traveled])

  return (
    <div className="route-proto-map-wrap">
      <div ref={containerRef} className="route-proto-map" aria-label="Симуляция маршрута рейда" />
      <span className="route-proto-rider" aria-label="Положение организатора рейда">
        <img src={`${import.meta.env.BASE_URL}brand/kabanda-logo-reference.png`} alt="" />
      </span>
      {status === 'loading' ? <p className="route-proto-map-state">Загружаем карту…</p> : null}
      {status === 'failed' ? <p className="route-proto-map-state route-proto-map-state--error">Не удалось построить велосипедный маршрут Яндекса.</p> : null}
    </div>
  )
}
