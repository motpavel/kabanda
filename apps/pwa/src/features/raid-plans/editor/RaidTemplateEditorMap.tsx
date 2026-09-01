import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { YandexMap, YandexMapsRuntime } from '../../kabandas/yandex-maps'
import {
  attachBicycleRoute,
  attachNumberedWaypointPlacemark,
  attachRaidPlanMapClick,
  loadRaidPlanYandex,
  straightLineDistanceMeters,
  toYandexCoordinates,
  type BicycleRouteState,
  type RaidPlanGeoPoint,
} from '../yandex-adapter'
import type { DraftRaidTemplatePoint } from '../types'

const INITIAL_CENTER = [56.8528, 53.2045] as const
const INITIAL_ZOOM = 12
const MIN_ZOOM = 10
const MAX_ZOOM = 18
const POINT_EDIT_ZOOM = 15
const WEB_MERCATOR_MAX_LATITUDE = 85.05112878

type RequestGenerationRef = { current: number }

export function beginLocationRequest(generationRef: RequestGenerationRef) {
  generationRef.current += 1
  return generationRef.current
}

export function invalidateLocationRequests(generationRef: RequestGenerationRef) {
  generationRef.current += 1
}

export function isCurrentLocationRequest(generationRef: RequestGenerationRef, requestGeneration: number) {
  return generationRef.current === requestGeneration
}

export function raidTemplatePointAtMapCenter(map: Pick<YandexMap, 'getCenter'>): RaidPlanGeoPoint | null {
  const [latitude, longitude] = map.getCenter()
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  return { latitude, longitude }
}

function latitudeToMercatorY(latitude: number) {
  const safeLatitude = Math.max(-WEB_MERCATOR_MAX_LATITUDE, Math.min(WEB_MERCATOR_MAX_LATITUDE, latitude))
  const sine = Math.sin(safeLatitude * Math.PI / 180)
  return .5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)
}

function mercatorYToLatitude(value: number) {
  const safeValue = Math.max(0, Math.min(1, value))
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * safeValue))) * 180 / Math.PI
}

/**
 * Keeps the selected point in the visual centre of the map area that remains
 * above the point sheet, rather than underneath the sheet itself.
 */
export function raidTemplateSelectedPointCenter(
  point: RaidPlanGeoPoint,
  zoom: number,
  viewportHeight: number,
  sheetHeight: number,
): readonly [number, number] {
  const safeViewportHeight = Math.max(1, viewportHeight)
  const safeSheetHeight = Math.max(0, Math.min(sheetHeight, safeViewportHeight * .82))
  const worldSize = 256 * 2 ** Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom))
  const pointY = latitudeToMercatorY(point.latitude)
  const mapCenterY = pointY + safeSheetHeight / (2 * worldSize)
  return [mercatorYToLatitude(mapCenterY), point.longitude]
}

export function RaidTemplateEditorMap({
  points,
  selectedPointId,
  pointSheetHeight,
  canAddPoint,
  onAddPoint,
  onRouteState,
  onSelectPoint,
}: {
  points: readonly DraftRaidTemplatePoint[]
  selectedPointId: string | null
  pointSheetHeight: number
  canAddPoint: boolean
  onAddPoint: (point: RaidPlanGeoPoint) => void
  onRouteState: (state: BicycleRouteState) => void
  onSelectPoint: (pointId: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<YandexMap | null>(null)
  const runtimeRef = useRef<YandexMapsRuntime | null>(null)
  const locationRequestGenerationRef = useRef(0)
  const addPointRef = useRef(onAddPoint)
  const selectPointRef = useRef(onSelectPoint)
  const routeStateRef = useRef(onRouteState)
  const [providerState, setProviderState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [retryVersion, setRetryVersion] = useState(0)
  const [zoom, setZoom] = useState(INITIAL_ZOOM)
  const [locating, setLocating] = useState(false)
  const selectedPoint = points.find((point) => point.clientId === selectedPointId) ?? null
  const selectedLatitude = selectedPoint?.latitude ?? null
  const selectedLongitude = selectedPoint?.longitude ?? null
  const coordinatesFingerprint = points.map((point) => `${point.latitude}:${point.longitude}`).join('|')
  const routePoints = useMemo<RaidPlanGeoPoint[]>(
    () => points.map(({ latitude, longitude }) => ({ latitude, longitude })),
    // The coordinate string intentionally ignores labels/comments so they do not trigger a billed route request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [coordinatesFingerprint],
  )

  addPointRef.current = onAddPoint
  selectPointRef.current = onSelectPoint
  routeStateRef.current = onRouteState

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let active = true
    setProviderState('loading')
    const apiKey = import.meta.env.VITE_YANDEX_MAPS_API_KEY?.trim() ?? ''

    void loadRaidPlanYandex(apiKey).then((runtime) => {
      if (!active) return
      const map = new runtime.Map(container, {
        center: INITIAL_CENTER,
        zoom: INITIAL_ZOOM,
        controls: [],
        behaviors: ['default', 'scrollZoom'],
        type: 'yandex#map',
      }, { suppressMapOpenBlock: true })
      map.events.add('boundschange', (event) => {
        const nextZoom = event.get<number | undefined>('newZoom')
        if (typeof nextZoom === 'number') setZoom(nextZoom)
      })
      mapRef.current = map
      runtimeRef.current = runtime
      setProviderState('ready')
    }).catch(() => {
      if (!active) return
      setProviderState('failed')
      if (routePoints.length >= 2) {
        routeStateRef.current({
          status: 'failed',
          code: 'provider_unavailable',
          fallbackDistanceMeters: straightLineDistanceMeters(routePoints),
        })
      }
    })

    return () => {
      active = false
      invalidateLocationRequests(locationRequestGenerationRef)
      runtimeRef.current = null
      mapRef.current?.destroy()
      mapRef.current = null
    }
  }, [retryVersion])

  useEffect(() => {
    const map = mapRef.current
    if (providerState !== 'ready' || !map) return
    let frame = 0
    const viewport = window.visualViewport

    const fitAndCenter = () => {
      map.container?.fitToViewport?.()
      if (selectedLatitude === null || selectedLongitude === null) return
      const viewportHeight = viewport?.height ?? window.innerHeight
      const targetZoom = Math.max(POINT_EDIT_ZOOM, map.getZoom())
      map.setCenter(raidTemplateSelectedPointCenter(
        { latitude: selectedLatitude, longitude: selectedLongitude },
        targetZoom,
        viewportHeight,
        pointSheetHeight,
      ), targetZoom, { duration: 220, timingFunction: 'ease-in-out' })
    }
    const scheduleFit = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(fitAndCenter)
    }

    scheduleFit()
    window.addEventListener('resize', scheduleFit)
    viewport?.addEventListener('resize', scheduleFit)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', scheduleFit)
      viewport?.removeEventListener('resize', scheduleFit)
    }
  }, [pointSheetHeight, providerState, selectedLatitude, selectedLongitude])

  useEffect(() => {
    const map = mapRef.current
    if (providerState !== 'ready' || !map || !canAddPoint) return
    return attachRaidPlanMapClick(map, (point) => addPointRef.current(point))
  }, [canAddPoint, providerState])

  useEffect(() => {
    const map = mapRef.current
    const runtime = runtimeRef.current
    if (providerState !== 'ready' || !map || !runtime) return
    const dispose = points.map((point, index) => attachNumberedWaypointPlacemark(
      runtime,
      map,
      point,
      index + 1,
      {
        selected: point.clientId === selectedPointId,
        onSelect: () => selectPointRef.current(point.clientId),
      },
    ))
    return () => dispose.forEach((cleanup) => cleanup())
  }, [points, providerState, selectedPointId])

  useEffect(() => {
    const map = mapRef.current
    const runtime = runtimeRef.current
    if (providerState !== 'ready' || !map || !runtime || routePoints.length < 2) return
    let disposeRoute = () => undefined
    let fallbackLine: object | null = null
    let fallbackTimer: number | null = null
    const showFallbackLine = () => {
      if (fallbackLine) return
      fallbackLine = new runtime.Polyline(routePoints.map(toYandexCoordinates), {}, {
        strokeColor: '#64676d',
        strokeOpacity: 0.78,
        strokeStyle: 'dash',
        strokeWidth: 3,
        zIndex: 1,
      })
      map.geoObjects.add(fallbackLine)
    }
    const timer = window.setTimeout(() => {
      disposeRoute = attachBicycleRoute(runtime, map, routePoints, (state) => {
        if (state.status === 'calculating') {
          fallbackTimer = window.setTimeout(() => {
            showFallbackLine()
            routeStateRef.current({
              status: 'failed',
              code: 'provider_unavailable',
              fallbackDistanceMeters: state.fallbackDistanceMeters,
            })
          }, 15_000)
        } else if (state.status === 'failed') {
          if (fallbackTimer !== null) window.clearTimeout(fallbackTimer)
          showFallbackLine()
        } else if (state.status === 'ready') {
          if (fallbackTimer !== null) window.clearTimeout(fallbackTimer)
          if (fallbackLine) {
            map.geoObjects.remove(fallbackLine)
            fallbackLine = null
          }
        }
        routeStateRef.current(state)
      })
    }, 450)
    return () => {
      window.clearTimeout(timer)
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer)
      disposeRoute()
      if (fallbackLine) map.geoObjects.remove(fallbackLine)
    }
  }, [providerState, routePoints])

  const changeZoom = useCallback((delta: number) => {
    const map = mapRef.current
    if (!map) return
    map.setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, map.getZoom() + delta)), { duration: 180 })
  }, [])

  const locate = useCallback(() => {
    const map = mapRef.current
    if (!map || !('geolocation' in navigator)) return
    const requestGeneration = beginLocationRequest(locationRequestGenerationRef)
    setLocating(true)
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      if (!isCurrentLocationRequest(locationRequestGenerationRef, requestGeneration) || mapRef.current !== map) return
      map.setCenter([coords.latitude, coords.longitude], 15, { duration: 300, timingFunction: 'ease-in-out' })
      setLocating(false)
    }, () => {
      if (!isCurrentLocationRequest(locationRequestGenerationRef, requestGeneration) || mapRef.current !== map) return
      setLocating(false)
    }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 })
  }, [])

  const addPointAtCenter = useCallback(() => {
    const map = mapRef.current
    if (!map || !canAddPoint) return
    const point = raidTemplatePointAtMapCenter(map)
    if (point) addPointRef.current(point)
  }, [canAddPoint])

  return <div className={`rt-map${selectedPoint ? ' rt-map--point-editing' : ''}`} role="group" aria-label="Карта конструктора маршрута">
    <div className="rt-map__stage" ref={containerRef} />
    {providerState === 'loading' && <div className="rt-map__status" role="status">Загружаем карту…</div>}
    {providerState === 'failed' && <div className="rt-map__status rt-map__status--error" role="alert">
      <strong>Карта не загрузилась</strong>
      <span>Черновик сохранён. Подключитесь к интернету и повторите.</span>
      <button onClick={() => setRetryVersion((version) => version + 1)} type="button">Повторить</button>
    </div>}
    {providerState === 'ready' && <>
      <div className="rt-map__instruction" aria-live="polite">
        {canAddPoint ? 'Коснитесь карты или добавьте точку в центре' : 'Добавлено максимум 10 точек'}
      </div>
      <RaidTemplateMapControls
        canAddPoint={canAddPoint}
        locating={locating}
        onAddPointAtCenter={addPointAtCenter}
        onChangeZoom={changeZoom}
        onLocate={locate}
        zoom={zoom}
      />
    </>}
  </div>
}

export function RaidTemplateMapControls({
  canAddPoint,
  locating,
  onAddPointAtCenter,
  onChangeZoom,
  onLocate,
  zoom,
}: {
  canAddPoint: boolean
  locating: boolean
  onAddPointAtCenter: () => void
  onChangeZoom: (delta: number) => void
  onLocate: () => void
  zoom: number
}) {
  return <div aria-label="Управление картой" className="rt-map__controls" role="group">
    <button aria-label="Приблизить карту" disabled={zoom >= MAX_ZOOM} onClick={() => onChangeZoom(1)} type="button">+</button>
    <button aria-label="Отдалить карту" disabled={zoom <= MIN_ZOOM} onClick={() => onChangeZoom(-1)} type="button">−</button>
    <button aria-label="Показать моё местоположение" disabled={locating} onClick={onLocate} type="button">
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20.6 3.4 4.2 9.6a1 1 0 0 0 .1 1.9l6.2 2 2 6.3a1 1 0 0 0 1.9.1Z" /></svg>
    </button>
    <button
      aria-label="Добавить точку в центре карты"
      className="rt-map__add-point"
      disabled={!canAddPoint}
      onClick={onAddPointAtCenter}
      type="button"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 21s6-5.1 6-11a6 6 0 1 0-12 0c0 5.9 6 11 6 11Z" />
        <path d="M12 7v6M9 10h6" />
      </svg>
    </button>
  </div>
}
