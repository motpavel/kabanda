import { useEffect, useRef, useState } from 'react'
import {
  loadYandexMaps,
  type YandexMap,
  type YandexMapObject,
  type YandexMapsRuntime,
} from '../../kabandas/yandex-maps'
import type { OneShotCoordinate } from '../../checkins/types'
import { getRaidMapPoints, getRouteTrack } from '../api'
import type { RaidMapPoint, RouteTrackPoint, RouteTrackProjection } from '../types'
import { readRaidMapCache, saveRaidMapCache } from './map-cache'
import { RaidControlIcon } from '../RaidControlIcon'
import { trackEndpoints } from './track-endpoints'
import { displayTrackSegment } from './track-display'

const IZHEVSK_CENTER = [56.8528, 53.2045] as const

function sameMapPoints(current: readonly RaidMapPoint[], next: readonly RaidMapPoint[]): boolean {
  return current.length === next.length && current.every((point, index) => {
    const candidate = next[index]
    return candidate !== undefined &&
      point.id === candidate.id &&
      point.visitedByMe === candidate.visitedByMe &&
      point.visitedByTeam === candidate.visitedByTeam
  })
}

export function routeTrackView(points: readonly (Pick<RouteTrackPoint, 'latitude' | 'longitude'> & Partial<Pick<RouteTrackPoint, 'capturedAt'>>)[], viewport?: { width: number; height: number }) {
  if (!points.length) return { center: IZHEVSK_CENTER, zoom: 12 }
  let minLatitude = points[0]!.latitude
  let maxLatitude = minLatitude
  let minLongitude = points[0]!.longitude
  let maxLongitude = minLongitude
  for (const point of points.slice(1)) {
    minLatitude = Math.min(minLatitude, point.latitude)
    maxLatitude = Math.max(maxLatitude, point.latitude)
    minLongitude = Math.min(minLongitude, point.longitude)
    maxLongitude = Math.max(maxLongitude, point.longitude)
  }
  if (viewport && viewport.width > 0 && viewport.height > 0) {
    const mercatorY = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, latitude)) * Math.PI / 360))
    const top = mercatorY(maxLatitude), bottom = mercatorY(minLatitude)
    const horizontalSpan = (maxLongitude - minLongitude) / 360
    const verticalSpan = (top - bottom) / (2 * Math.PI)
    // Keep endpoint labels and attribution inside the embedded completed-ride map.
    const scaleX = Math.max(80, viewport.width - 160) / (256 * Math.max(horizontalSpan, 1e-10))
    const scaleY = Math.max(80, viewport.height - 144) / (256 * Math.max(verticalSpan, 1e-10))
    return {
      center: [(2 * Math.atan(Math.exp((top + bottom) / 2)) - Math.PI / 2) * 180 / Math.PI, (minLongitude + maxLongitude) / 2] as const,
      zoom: Math.max(1, Math.min(17, Math.floor(Math.log2(Math.min(scaleX, scaleY))))),
    }
  }
  const span = Math.max(maxLatitude - minLatitude, maxLongitude - minLongitude)
  const zoom = span > .08 ? 12 : span > .04 ? 13 : span > .02 ? 14 : span > .01 ? 15 : span > .005 ? 16 : 17
  return {
    center: [(minLatitude + maxLatitude) / 2, (minLongitude + maxLongitude) / 2] as const,
    zoom,
  }
}

export function userMarkerCoordinate(location: OneShotCoordinate | null): readonly [number, number] | null {
  return location ? [location.latitude, location.longitude] : null
}

export function RaidRouteMap({
  identityId,
  planned = false,
  completed = false,
  raidId,
  live,
  location,
  highlightedPointId,
  destinationPointId = null,
  onSelectPoint,
}: {
  identityId: string
  planned?: boolean
  completed?: boolean
  raidId: string
  live: boolean
  location: OneShotCoordinate | null
  highlightedPointId: string | null
  destinationPointId?: string | null
  onSelectPoint: (point: RaidMapPoint) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<YandexMap | null>(null)
  const runtimeRef = useRef<YandexMapsRuntime | null>(null)
  const routeObjectsRef = useRef<YandexMapObject[]>([])
  const pointObjectsRef = useRef<YandexMapObject[]>([])
  const riderRef = useRef<YandexMapObject | null>(null)
  const firstViewApplied = useRef(false)
  const firstLocationApplied = useRef(false)
  const [following, setFollowing] = useState(false)
  const mapGesture = useRef<{ id: number; x: number; y: number } | null>(null)
  const [providerState, setProviderState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [track, setTrack] = useState<RouteTrackProjection | null>(null)
  const [points, setPoints] = useState<RaidMapPoint[]>([])
  const [dataState, setDataState] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let active = true
    const resize = new ResizeObserver(() => {
      const map = mapRef.current
      if (!map) return
      const center = map.getCenter(), zoom = map.getZoom()
      map.container?.fitToViewport?.()
      map.setCenter(center, zoom, { duration: 0 })
    })
    resize.observe(container)
    const apiKey = import.meta.env.VITE_YANDEX_MAPS_API_KEY?.trim() ?? ''
    void loadYandexMaps(apiKey).then((runtime) => {
      if (!active) return
      runtimeRef.current = runtime
      mapRef.current = new runtime.Map(container, {
        center: IZHEVSK_CENTER,
        zoom: 12,
        controls: [],
        behaviors: ['default', 'scrollZoom'],
        type: 'yandex#map',
      }, { suppressMapOpenBlock: true })
      setProviderState('ready')
    }).catch(() => {
      if (active) setProviderState('failed')
    })
    return () => {
      resize.disconnect()
      active = false
      mapRef.current?.destroy()
      mapRef.current = null
      runtimeRef.current = null
      routeObjectsRef.current = []
      pointObjectsRef.current = []
      riderRef.current = null
    }
  }, [])

  useEffect(() => {
    let active = true
    let inFlight = false
    void readRaidMapCache(identityId, raidId).then((cached) => {
      if (!active || !cached) return
      setTrack((current) => current ?? cached.track)
      setPoints((current) => current.length ? current : cached.points)
      setDataState('ready')
    }).catch(() => undefined)
    const refresh = async () => {
      if (inFlight || !navigator.onLine) return
      inFlight = true
      try {
        const [nextTrack, nextPoints] = await Promise.all([
          getRouteTrack(raidId),
          getRaidMapPoints(raidId),
        ])
        if (!active) return
        setTrack((current) => current?.updatedAt === nextTrack.updatedAt && current.pointCount === nextTrack.pointCount ? current : nextTrack)
        setPoints((current) => sameMapPoints(current, nextPoints) ? current : nextPoints)
        setDataState('ready')
        void saveRaidMapCache(identityId, raidId, nextPoints, nextTrack).catch(() => undefined)
      } catch {
        if (active) setDataState('failed')
      } finally {
        inFlight = false
      }
    }
    void refresh()
    const timer = live ? window.setInterval(() => void refresh(), 5_000) : null
    const onOnline = () => void refresh()
    window.addEventListener('online', onOnline)
    return () => {
      active = false
      if (timer !== null) window.clearInterval(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [identityId, live, raidId])

  useEffect(() => {
    const map = mapRef.current
    const runtime = runtimeRef.current
    if (providerState !== 'ready' || !map || !runtime || !track) return
    for (const object of routeObjectsRef.current) map.geoObjects.remove(object)
    routeObjectsRef.current = []

    const trackPoints = track.segments.flat()
    for (const segment of track.segments) {
      if (segment.length < 2) continue
      const coordinates = displayTrackSegment(segment)
      const casing = new runtime.Polyline(coordinates, {}, {
        strokeColor: '#ffffff',
        strokeOpacity: .96,
        strokeWidth: 9,
        zIndex: 2,
      })
      const line = new runtime.Polyline(coordinates, {}, {
        strokeColor: '#17191b',
        strokeOpacity: 1,
        strokeWidth: 5,
        zIndex: 3,
      })
      routeObjectsRef.current.push(casing, line)
      map.geoObjects.add(casing)
      map.geoObjects.add(line)
    }

    const endpointLayout = runtime.templateLayoutFactory.createClass('<span class="raid-track-endpoint raid-track-endpoint--{{ properties.kind }}" role="img" aria-label="{{ properties.label }}"><i></i><b>{{ properties.label }}</b></span>')
    for (const endpoint of trackEndpoints(track, completed)) {
      const marker = new runtime.Placemark([endpoint.point.latitude, endpoint.point.longitude], { kind: endpoint.kind, label: endpoint.label }, {
        iconLayout: endpointLayout, hasBalloon: false, hasHint: false, interactiveZIndex: false, zIndex: 15,
      })
      routeObjectsRef.current.push(marker)
      map.geoObjects.add(marker)
    }

    if (!firstViewApplied.current && trackPoints.length > 0) {
      const view = routeTrackView([...trackPoints, ...trackEndpoints(track, completed).map(({ point }) => point)], completed ? containerRef.current?.getBoundingClientRect() : undefined)
      map.setCenter(view.center, view.zoom, { duration: 0 })
      firstViewApplied.current = true
    }
  }, [providerState, track, completed])

  useEffect(() => {
    const map = mapRef.current
    const runtime = runtimeRef.current
    if (providerState !== 'ready' || !map || !runtime) return
    for (const object of pointObjectsRef.current) map.geoObjects.remove(object)
    pointObjectsRef.current = []

    const pointLayout = runtime.templateLayoutFactory.createClass(
      '<button type="button" class="{{ properties.markerClass }}" aria-label="{{ properties.ariaLabel }}"></button>',
    )
    if (planned && points.length > 1) {
      const path = [...points].sort((a, b) => a.position - b.position)
      const line = new runtime.Polyline(path.map(({ latitude, longitude }) => [latitude, longitude] as const), {}, {
        strokeColor: '#e84b43', strokeWidth: 3, strokeStyle: 'shortdash', zIndex: 1,
      })
      pointObjectsRef.current.push(line)
      map.geoObjects.add(line)
    }
    for (const point of points) {
      const highlighted = point.id === highlightedPointId
      const isDestination = point.id === destinationPointId
      const visited = point.visitedByMe
      const markerClass = `raid-live-point${visited ? ' raid-live-point--visited' : ''}${highlighted && !visited ? ' raid-live-point--nearby' : ''}${isDestination ? ' raid-live-point--destination' : ''}`
      const marker = new runtime.Placemark([point.latitude, point.longitude], {
        markerClass,
        ariaLabel: `${point.name}. ${isDestination ? 'Цель рейда. ' : ''}${point.visitedByMe ? 'Вы уже были. История посещений' : point.visitedByTeam ? 'Кабанда уже была. История посещений' : highlighted ? 'Вы рядом, подтвердите посещение' : 'Точка рейда. История посещений'}`,
      }, {
        iconLayout: pointLayout,
        iconShape: { type: 'Circle', coordinates: [0, 0], radius: highlighted && !visited && !isDestination ? 22 : 16 },
        hasBalloon: false,
        hasHint: false,
        interactiveZIndex: false,
        zIndex: isDestination ? 25 : highlighted ? 24 : 20,
      })
      marker.events.add('click', (event) => { event.stopPropagation?.(); onSelectPoint(point) })
      pointObjectsRef.current.push(marker)
      map.geoObjects.add(marker)
    }

    if (!firstViewApplied.current && points.length > 0) {
      const view = routeTrackView(points, completed ? containerRef.current?.getBoundingClientRect() : undefined)
      map.setCenter(view.center, view.zoom, { duration: 0 })
      firstViewApplied.current = true
    }
  }, [completed, destinationPointId, highlightedPointId, onSelectPoint, planned, points, providerState])

  useEffect(() => {
    const map = mapRef.current
    const runtime = runtimeRef.current
    if (providerState !== 'ready' || !map || !runtime) return
    if (riderRef.current) map.geoObjects.remove(riderRef.current)
    riderRef.current = null

    const markerCoordinate = userMarkerCoordinate(location)
    if (!markerCoordinate) return
    const riderLayout = runtime.templateLayoutFactory.createClass(
      '<span class="route-live-map__rider" aria-label="Моё положение"></span>',
    )
    const rider = new runtime.Placemark(markerCoordinate, {}, {
      iconLayout: riderLayout,
      iconShape: { type: 'Circle', coordinates: [0, 0], radius: 16 },
      hasBalloon: false,
      hasHint: false,
      interactiveZIndex: false,
      zIndex: 10,
    })
    riderRef.current = rider
    map.geoObjects.add(rider)

    if (location && !firstLocationApplied.current) {
      map.setCenter([location.latitude, location.longitude], 15, {
        duration: firstViewApplied.current ? 260 : 0,
        timingFunction: 'ease-in-out',
      })
      firstLocationApplied.current = true
      firstViewApplied.current = true
    }
  }, [location, providerState])

  const changeZoom = (delta: number) => {
    const map = mapRef.current
    if (map) map.setZoom(Math.max(3, Math.min(19, map.getZoom() + delta)), { duration: 180 })
  }

  useEffect(() => {
    const map = mapRef.current
    if (!following || providerState !== 'ready' || !map || !location) return
    firstLocationApplied.current = true
    firstViewApplied.current = true
    map.setCenter([location.latitude, location.longitude], map.getZoom(), {
      duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260,
      timingFunction: 'ease-in-out',
    })
  }, [following, location, providerState])

  const stopFollowing = () => {
    setFollowing(false)
    // A late first GPS fix or track response must not undo manual browsing.
    firstLocationApplied.current = true
    firstViewApplied.current = true
  }

  return <div className="route-live-map-shell">
    {planned && <p className="raid-route-legend">Пунктир — порядок точек, не навигация · чёрный — пройденный путь</p>}
    <div className="route-live-map" ref={containerRef}
      onPointerDownCapture={(event) => {
        if (!event.isPrimary) { stopFollowing(); return }
        if (event.button !== 0) return
        mapGesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
      }}
      onPointerMoveCapture={(event) => {
        const start = mapGesture.current
        if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) stopFollowing()
      }}
      onPointerUpCapture={() => { mapGesture.current = null }}
      onPointerCancelCapture={() => { if (mapGesture.current) stopFollowing(); mapGesture.current = null }}
      onWheelCapture={stopFollowing}
      onDoubleClickCapture={stopFollowing}
      onKeyDownCapture={(event) => { if (event.key.startsWith('Arrow')) stopFollowing() }}
    />
    <nav className="raid-map-controls" aria-label="Управление картой">
      <button aria-label="Увеличить карту" onClick={() => changeZoom(1)} type="button"><RaidControlIcon name="plus" /></button>
      <button aria-label="Уменьшить карту" onClick={() => changeZoom(-1)} type="button"><RaidControlIcon name="minus" /></button>
      <button aria-label="Показать моё местоположение" aria-pressed={following} className="raid-map-controls__follow" disabled={!location || providerState !== 'ready'} onClick={() => setFollowing((current) => !current)} type="button"><RaidControlIcon name="location" /></button>
    </nav>
    {providerState === 'loading' && <p className="route-live-map__state" role="status">Загружаем карту…</p>}
    {providerState === 'failed' && <p className="route-live-map__state route-live-map__state--error" role="alert">Карта не загрузилась.{live ? ' Трек продолжает записываться.' : ' Проверьте соединение и откройте рейд снова.'}</p>}
    {providerState === 'ready' && dataState === 'loading' && <p className="route-live-map__state" role="status">Открываем точки рейда…</p>}
    {providerState === 'ready' && dataState === 'failed' && !track && <p className="route-live-map__state route-live-map__state--error" role="alert">Не удалось загрузить карту рейда. Повторим автоматически.</p>}
    {track?.truncated && <p className="route-live-map__state route-live-map__state--notice">Показана первая часть длинного трека.</p>}
  </div>
}
