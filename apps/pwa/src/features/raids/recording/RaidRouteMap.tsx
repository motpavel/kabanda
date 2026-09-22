import { useEffect, useMemo, useRef, useState } from 'react'
import { loadYandexMaps, type YandexMap, type YandexPlacemark, type YandexPolyline, type YandexMapsRuntime } from '../../kabandas/yandex-maps'
import type { OneShotCoordinate } from '../../checkins/types'
import type { RaidMapPoint, RouteTrackPoint } from '../types'
import { RaidControlIcon } from '../RaidControlIcon'
import { trackEndpoints } from './track-endpoints'
import { updateTrackLayers, type TrackLayers } from './track-layers'
import { useRaidMapData } from './useRaidMapData'
import { FlockDisplay } from './flock-display'
import { stabilizeStationarySegment } from './stationary-display'
import { RiderMotion } from './rider-motion'
import { completedRouteBoundsPoints, pointsForRaidMap } from './completed-route-view'
import { LiveRouteTail, navigatorMotionMarker, type TailCoordinate, type TailFix } from './live-route-tail'
import { LiveRouteLayers } from './live-route-layers'

const IZHEVSK_CENTER = [56.8528, 53.2045] as const
export function routeTrackView(points: readonly (Pick<RouteTrackPoint, 'latitude' | 'longitude'> & Partial<Pick<RouteTrackPoint, 'capturedAt'>>)[], viewport?: { width: number; height: number }) {
  if (!points.length) return { center: IZHEVSK_CENTER, zoom: 12 }
  let minLatitude = points[0]!.latitude, maxLatitude = minLatitude
  let minLongitude = points[0]!.longitude, maxLongitude = minLongitude
  for (const point of points.slice(1)) {
    minLatitude = Math.min(minLatitude, point.latitude); maxLatitude = Math.max(maxLatitude, point.latitude)
    minLongitude = Math.min(minLongitude, point.longitude); maxLongitude = Math.max(maxLongitude, point.longitude)
  }
  if (viewport && viewport.width > 0 && viewport.height > 0) {
    const mercatorY = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, latitude)) * Math.PI / 180 / 2))
    const top = mercatorY(maxLatitude), bottom = mercatorY(minLatitude)
    const scaleX = Math.max(80, viewport.width - 160) / (256 * Math.max((maxLongitude - minLongitude) / 360, 1e-10))
    const scaleY = Math.max(80, viewport.height - 144) / (256 * Math.max((top - bottom) / (2 * Math.PI), 1e-10))
    return { center: [(2 * Math.atan(Math.exp((top + bottom) / 2)) - Math.PI / 2) * 180 / Math.PI, (minLongitude + maxLongitude) / 2] as const,
      zoom: Math.max(1, Math.min(17, Math.floor(Math.log2(Math.min(scaleX, scaleY))))) }
  }
  const span = Math.max(maxLatitude - minLatitude, maxLongitude - minLongitude)
  return { center: [(minLatitude + maxLatitude) / 2, (minLongitude + maxLongitude) / 2] as const,
    zoom: span > .08 ? 12 : span > .04 ? 13 : span > .02 ? 14 : span > .01 ? 15 : span > .005 ? 16 : 17 }
}
export function userMarkerCoordinate(location: OneShotCoordinate | null): readonly [number, number] | null {
  return location ? [location.latitude, location.longitude] : null
}

export function RaidRouteMap({ identityId, navigatorUserId = null, navigatorSampleAt = null, planned = false,
  completed = false, localRoutePreview = false, raidId, live, location, highlightedPointId, destinationPointId = null, onSelectPoint, onMapTap,
}: {
  identityId: string; navigatorUserId?: string | null; navigatorSampleAt?: string | null; planned?: boolean
  completed?: boolean; localRoutePreview?: boolean; raidId: string; live: boolean; location: OneShotCoordinate | null
  highlightedPointId: string | null; destinationPointId?: string | null; onSelectPoint: (point: RaidMapPoint) => void; onMapTap?: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<YandexMap | null>(null)
  const runtimeRef = useRef<YandexMapsRuntime | null>(null)
  const trackLayers = useRef<TrackLayers>(new Map())
  const endpoints = useRef(new Map<string, YandexPlacemark>())
  const pointMarkers = useRef(new Map<string, { marker: YandexPlacemark; point: RaidMapPoint; signature: string }>())
  const plannedLine = useRef<YandexPolyline | null>(null)
  const riders = useRef(new Map<string, YandexPlacemark>())
  const flock = useRef(new FlockDisplay())
  const motion = useRef<RiderMotion | null>(null)
  const viewerMotionId = useRef<string | null>(null)
  const navigatorMotionId = useRef<string | null>(null)
  const previewStarted = useRef(false)
  const renderedRiders = useRef<ReadonlyMap<string, TailCoordinate>>(new Map())
  const drawnTrackAnchor = useRef<TailFix | null>(null)
  const previewLayers = useRef<LiveRouteLayers | null>(null)
  const preview = useRef<LiveRouteTail | null>(null)
  if (!preview.current) preview.current = new LiveRouteTail(frame => previewLayers.current?.update(frame))
  const followEnabled = useRef(false)
  const viewerCoordinate = useRef<readonly [number, number] | null>(null)
  const [markerNow, setMarkerNow] = useState(Date.now)
  const onSelect = useRef(onSelectPoint)
  onSelect.current = onSelectPoint
  const firstView = useRef(false), firstLocation = useRef(false)
  const [following, setFollowing] = useState(false)
  const gesture = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null)
  const [provider, setProvider] = useState<'loading' | 'ready' | 'failed'>('loading')
  const { track, points: allPoints, dataState, positions, snapshotNavigator, routePreviewScope, routePreviewIssuedAt } = useRaidMapData(identityId, raidId, live, completed)
  const points = useMemo(() => pointsForRaidMap(allPoints, completed), [allPoints, completed])

  useEffect(() => {
    firstView.current = false; firstLocation.current = false; flock.current.reset(); viewerCoordinate.current = null
    motion.current?.reset(); viewerMotionId.current = null; followEnabled.current = false
    preview.current?.reset(); previewStarted.current = false; navigatorMotionId.current = null; renderedRiders.current = new Map(); drawnTrackAnchor.current = null
    setFollowing(false)
  }, [identityId, raidId, completed])
  useEffect(() => {
    motion.current?.reset(); renderedRiders.current = new Map()
    navigatorMotionId.current = null
    if (!previewStarted.current && routePreviewScope && (identityId !== navigatorUserId || localRoutePreview)) {
      preview.current?.reset(); previewStarted.current = true
    } else preview.current?.interrupt(Date.now())
  }, [identityId, navigatorUserId, routePreviewScope, localRoutePreview])
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
    void loadYandexMaps(import.meta.env.VITE_YANDEX_MAPS_API_KEY?.trim() ?? '').then(runtime => {
      if (!active) return
      runtimeRef.current = runtime
      mapRef.current = new runtime.Map(container, { center: IZHEVSK_CENTER, zoom: 12, controls: [],
        behaviors: ['default', 'scrollZoom'], type: 'yandex#map' }, { suppressMapOpenBlock: true })
      previewLayers.current = new LiveRouteLayers(mapRef.current, runtime)
      setProvider('ready')
    }).catch(() => { if (active) setProvider('failed') })
    return () => {
      active = false; resize.disconnect(); motion.current?.reset(); preview.current?.reset()
      previewLayers.current?.clear(); previewLayers.current = null
      mapRef.current?.destroy(); mapRef.current = null; runtimeRef.current = null
      trackLayers.current.clear(); endpoints.current.clear(); pointMarkers.current.clear(); riders.current.clear(); plannedLine.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (provider !== 'ready' || !map) return
    const animation = new RiderMotion(coordinates => {
      if (mapRef.current !== map) return
      renderedRiders.current = coordinates
      for (const [id, coordinate] of coordinates) riders.current.get(id)?.geometry?.setCoordinates(coordinate)
      const navigator = navigatorMotionId.current ? coordinates.get(navigatorMotionId.current) : undefined
      if (navigator) preview.current?.paint(navigator)
      const viewer = viewerMotionId.current ? coordinates.get(viewerMotionId.current) : undefined
      viewerCoordinate.current = viewer ?? null
      // Camera and icon consume the SAME rendered coordinate. Competing map
      // easing towards the raw target would make the boar drift off centre.
      if (viewer && followEnabled.current && document.visibilityState === 'visible') {
        map.setCenter(viewer, map.getZoom(), { duration: 0 })
      }
    }, { now: () => performance.now(), request: callback => requestAnimationFrame(callback), cancel: handle => cancelAnimationFrame(handle) })
    motion.current = animation
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    const policy = () => {
      if (document.visibilityState !== 'visible') {
        preview.current?.interrupt(Date.now()); animation.reset(); renderedRiders.current = new Map()
      }
      animation.setEnabled(document.visibilityState === 'visible' && !reducedMotion.matches)
      if (document.visibilityState === 'visible') setMarkerNow(Date.now())
    }
    policy()
    document.addEventListener('visibilitychange', policy)
    reducedMotion.addEventListener('change', policy)
    return () => {
      document.removeEventListener('visibilitychange', policy)
      reducedMotion.removeEventListener('change', policy)
      animation.reset()
      if (motion.current === animation) motion.current = null
    }
  }, [provider])

  useEffect(() => {
    const map = mapRef.current, runtime = runtimeRef.current
    if (provider !== 'ready' || !map || !runtime) return
    const segments = track?.segments.map(stabilizeStationarySegment) ?? []
    updateTrackLayers(map, runtime, trackLayers.current, segments)
    // Install canonical geometry first. A lastSampleAt in the fast feed is not
    // proof that the corresponding route page is already drawn.
    const drawnEnd = track && !track.truncated ? segments.filter(segment => segment.length).at(-1)?.at(-1) : null
    drawnTrackAnchor.current = drawnEnd ? { coordinate: [drawnEnd.latitude, drawnEnd.longitude], observedAt: Date.parse(drawnEnd.capturedAt) } : null
    const nextEndpoints = track ? trackEndpoints(track, completed) : []
    for (const [kind, marker] of endpoints.current) if (!nextEndpoints.some(endpoint => endpoint.kind === kind)) {
      map.geoObjects.remove(marker); endpoints.current.delete(kind)
    }
    for (const endpoint of nextEndpoints) {
      const coordinate = [endpoint.point.latitude, endpoint.point.longitude] as const
      const previous = endpoints.current.get(endpoint.kind)
      if (previous) { previous.geometry?.setCoordinates(coordinate); continue }
      const layout = runtime.templateLayoutFactory.createClass('<span class="raid-track-endpoint raid-track-endpoint--{{ properties.kind }}" role="img" aria-label="{{ properties.label }}"><i></i><b>{{ properties.label }}</b></span>')
      const marker = new runtime.Placemark(coordinate, { kind: endpoint.kind, label: endpoint.label }, {
        iconLayout: layout, hasBalloon: false, hasHint: false, interactiveZIndex: false, zIndex: 15,
      })
      endpoints.current.set(endpoint.kind, marker); map.geoObjects.add(marker)
    }
    if (!completed && !firstView.current && segments.some(segment => segment.length)) {
      const view = routeTrackView([...segments.flat(), ...nextEndpoints.map(endpoint => endpoint.point)], completed ? containerRef.current?.getBoundingClientRect() : undefined)
      map.setCenter(view.center, view.zoom, { duration: 0 }); firstView.current = true
    }
  }, [provider, track, completed])

  useEffect(() => {
    const map = mapRef.current, runtime = runtimeRef.current
    if (provider !== 'ready' || !map || !runtime) return
    const ids = new Set(points.map(point => point.id))
    for (const [id, entry] of pointMarkers.current) if (!ids.has(id)) { map.geoObjects.remove(entry.marker); pointMarkers.current.delete(id) }
    if (planned && !completed && points.length > 1) {
      const coordinates = [...points].sort((a, b) => a.position - b.position).map(point => [point.latitude, point.longitude] as const)
      if (plannedLine.current) plannedLine.current.geometry.setCoordinates(coordinates)
      else {
        plannedLine.current = new runtime.Polyline(coordinates, {}, { strokeColor: '#e84b43', strokeWidth: 3, strokeStyle: 'shortdash', zIndex: 1 })
        map.geoObjects.add(plannedLine.current)
      }
    } else if (plannedLine.current) { map.geoObjects.remove(plannedLine.current); plannedLine.current = null }
    for (const point of points) {
      const highlighted = !completed && point.id === highlightedPointId, destination = !completed && point.id === destinationPointId
      const visited = point.visitedByMe || point.visitedByTeam
      const markerClass = `raid-live-point${visited ? ' raid-live-point--visited' : ''}${highlighted && !visited ? ' raid-live-point--nearby' : ''}${destination ? ' raid-live-point--destination' : ''}`
      const ariaLabel = `${point.name}. ${destination ? 'Цель рейда. ' : ''}${point.visitedByMe ? 'Вы уже были. История посещений' : point.visitedByTeam ? 'Кабанда уже была. История посещений' : highlighted ? 'Вы рядом, подтвердите посещение' : 'Точка рейда. История посещений'}`
      const signature = JSON.stringify([markerClass, ariaLabel, point.latitude, point.longitude])
      const previous = pointMarkers.current.get(point.id)
      const shape = { type: 'Circle', coordinates: [0, 0], radius: highlighted && !visited && !destination ? 22 : 16 }
      if (previous) {
        previous.point = point
        if (previous.signature === signature) continue
        previous.signature = signature
        previous.marker.properties.set('markerClass', markerClass); previous.marker.properties.set('ariaLabel', ariaLabel)
        previous.marker.options.set('iconShape', shape); previous.marker.options.set('zIndex', highlighted ? 40 : destination ? 35 : 20)
        previous.marker.geometry?.setCoordinates([point.latitude, point.longitude])
        continue
      }
      const layout = runtime.templateLayoutFactory.createClass('<button type="button" class="{{ properties.markerClass }}" data-raid-point="{{ properties.pointId }}" aria-label="{{ properties.ariaLabel }}"></button>')
      const marker = new runtime.Placemark([point.latitude, point.longitude], { markerClass, ariaLabel, pointId: point.id }, {
        iconLayout: layout, iconShape: shape, hasBalloon: false, hasHint: false, interactiveZIndex: false, zIndex: highlighted ? 40 : destination ? 35 : 20,
      })
      const entry = { marker, point, signature }
      marker.events.add('click', event => { event.stopPropagation?.(); onSelect.current(entry.point) })
      pointMarkers.current.set(point.id, entry); map.geoObjects.add(marker)
    }
    if (!completed && !firstView.current && points.length) {
      const view = routeTrackView(points, completed ? containerRef.current?.getBoundingClientRect() : undefined)
      map.setCenter(view.center, view.zoom, { duration: 0 }); firstView.current = true
    }
  }, [provider, points, planned, highlightedPointId, destinationPointId, completed])

  useEffect(() => {
    const map = mapRef.current
    if (!completed || provider !== 'ready' || !map || firstView.current) return
    const overview = completedRouteBoundsPoints(track, points)
    if (!overview.length) return
    const view = routeTrackView(overview, containerRef.current?.getBoundingClientRect())
    map.setCenter(view.center, view.zoom, { duration: 0 }); firstView.current = true
  }, [completed, provider, track, points])

  useEffect(() => {
    if (!live) return
    setMarkerNow(Date.now())
    const timer = setInterval(() => setMarkerNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [live])
  useEffect(() => {
    const map = mapRef.current, runtime = runtimeRef.current
    if (provider !== 'ready' || !map || !runtime) return
    const markers = flock.current.select({ identityId, navigatorUserId, location, track, live, now: Date.now(),
      ...(positions === undefined ? {} : { positions }),
      navigatorSampleAt: snapshotNavigator?.userId === navigatorUserId ? snapshotNavigator.sampleAt : navigatorSampleAt })
    for (const [id, marker] of riders.current) if (!markers.some(next => next.id === id)) { map.geoObjects.remove(marker); riders.current.delete(id) }
    for (const spec of markers) {
      const coordinate = [spec.point.latitude, spec.point.longitude] as const
      const markerClass = `route-live-map__rider route-live-map__rider--${spec.kind}${spec.stale ? ' route-live-map__rider--stale' : ''}`
      const existing = riders.current.get(spec.id)
      if (existing) {
        existing.properties.set('markerClass', markerClass); existing.properties.set('label', spec.label)
      } else {
        const layout = runtime.templateLayoutFactory.createClass('<span class="{{ properties.markerClass }}" role="img" aria-label="{{ properties.label }}" title="{{ properties.label }}"></span>')
        const marker = new runtime.Placemark(coordinate, { markerClass, label: spec.label }, {
          iconLayout: layout, iconShape: { type: 'Circle', coordinates: [0, 0], radius: 24 }, hasBalloon: false, hasHint: false, interactiveZIndex: false, zIndex: 30,
        })
        riders.current.set(spec.id, marker); map.geoObjects.add(marker)
      }
    }
    const viewer = markers.find(marker => marker.id === 'viewer' || marker.members.includes(identityId))
    viewerMotionId.current = viewer?.id ?? null
    const navigatorMarker = navigatorMotionMarker(markers, identityId, navigatorUserId)
    const rawNavigator = identityId === navigatorUserId ? location : positions?.find(point => point.userId === navigatorUserId)
    const rawAge = rawNavigator ? Date.now() - Date.parse(rawNavigator.capturedAt) : Infinity
    const previewAllowed = Boolean(routePreviewScope && live && !completed && document.visibilityState === 'visible' &&
      snapshotNavigator?.userId === navigatorUserId && (identityId !== navigatorUserId || localRoutePreview) &&
      navigatorMarker && rawNavigator && Number.isFinite(rawNavigator.accuracyMeters) &&
      rawNavigator.accuracyMeters >= 0 && rawNavigator.accuracyMeters <= 50 && rawAge >= -5000 && rawAge <= 10_000 &&
      Date.parse(navigatorMarker.point.capturedAt) >= routePreviewIssuedAt)
    if (previewAllowed && !navigatorMotionId.current) {
      // The first usable fix after a pause/hidden interval/group change starts
      // a new visible fragment, not a tween from an ineligible old location.
      motion.current?.reset(); renderedRiders.current = new Map()
    }
    navigatorMotionId.current = previewAllowed ? navigatorMarker!.id : null
    if (previewAllowed) {
      const point = navigatorMarker!.point
      const anchor = drawnTrackAnchor.current
      preview.current?.update(routePreviewScope!, { coordinate: [point.latitude, point.longitude], observedAt: Date.parse(point.capturedAt) },
        anchor && anchor.observedAt >= routePreviewIssuedAt ? anchor : null, Date.now())
    } else preview.current?.interrupt(Date.now())
    motion.current?.update(markers.map(spec => ({
      id: spec.id,
      anchorId: spec.members.includes(identityId) ? identityId : navigatorUserId && spec.members.includes(navigatorUserId) ? navigatorUserId : spec.members[0] ?? spec.id,
      members: spec.members, coordinate: [spec.point.latitude, spec.point.longitude] as const,
      observedAt: Date.parse(spec.point.capturedAt), stale: spec.stale || !live,
    })))
    // Duplicated snapshots need no RiderMotion frame, but a newly drawn route
    // page may still retire a temporary preview. Never depend on another GPS fix.
    const renderedNavigator = navigatorMotionId.current ? renderedRiders.current.get(navigatorMotionId.current) : undefined
    if (renderedNavigator) preview.current?.paint(renderedNavigator)
    if (location && !firstLocation.current && viewerCoordinate.current) {
      map.setCenter(viewerCoordinate.current, 15, { duration: firstView.current ? 260 : 0, timingFunction: 'ease-in-out' })
      firstLocation.current = true; firstView.current = true
    }
  }, [identityId, live, completed, localRoutePreview, location, markerNow, navigatorSampleAt, navigatorUserId, positions, provider, snapshotNavigator, track, routePreviewScope, routePreviewIssuedAt])

  useEffect(() => {
    followEnabled.current = following
    const map = mapRef.current, coordinate = viewerCoordinate.current
    if (!following || provider !== 'ready' || !map || !coordinate) return
    firstLocation.current = true; firstView.current = true
    map.setCenter(coordinate, map.getZoom(), { duration: 0 })
  }, [following, provider])
  const stopFollowing = () => { followEnabled.current = false; setFollowing(false); firstLocation.current = true; firstView.current = true }
  const zoom = (delta: number) => {
    const map = mapRef.current
    if (map) map.setZoom(Math.max(3, Math.min(19, map.getZoom() + delta)), { duration: 180 })
  }
  return <div className="route-live-map-shell">
    {((planned && !completed) || (track?.segments.length ?? 0) > 1) && <p className="raid-route-legend">{planned && !completed ? 'Цветной пунктир — план · ' : ''}Чёрная линия — записанный путь; серый пунктир — соединение без GPS</p>}
    <div className="route-live-map" ref={containerRef}
      onPointerDownCapture={event => {
        if (event.target instanceof Element && event.target.closest('[data-raid-point]')) { gesture.current = null; return }
        if (!event.isPrimary) { gesture.current = null; stopFollowing(); return }
        if (event.button === 0) gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
      }}
      onPointerMoveCapture={event => { const start = gesture.current; if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) { start.moved = true; stopFollowing() } }}
      onPointerUpCapture={event => {
        const start = gesture.current
        gesture.current = null
        if (start?.id !== event.pointerId || start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return
        // Yandex places an events pane above HTML markers, so event.target
        // can be the map even when the user taps directly on a point.
        const hit = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-raid-point]')]
          .map(marker => {
            const box = marker.getBoundingClientRect()
            return { marker, distance: Math.hypot(event.clientX - (box.left + box.width / 2), event.clientY - (box.top + box.height / 2)), radius: Math.max(22, box.width / 2) }
          })
          .filter(item => item.distance <= item.radius)
          .sort((a, b) => a.distance - b.distance)[0]
        const entry = hit?.marker.dataset.raidPoint ? pointMarkers.current.get(hit.marker.dataset.raidPoint) : null
        if (entry) onSelect.current(entry.point)
        else onMapTap?.()
      }}
      onClickCapture={event => {
        const marker = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-raid-point]') : null
        const entry = marker?.dataset.raidPoint ? pointMarkers.current.get(marker.dataset.raidPoint) : null
        if (!entry) return
        event.stopPropagation()
        onSelect.current(entry.point)
      }}
      onPointerCancelCapture={() => { if (gesture.current) stopFollowing(); gesture.current = null }}
      onWheelCapture={stopFollowing} onDoubleClickCapture={stopFollowing}
      onKeyDownCapture={event => { if (event.key.startsWith('Arrow')) stopFollowing() }} />
    <nav className="raid-map-controls" aria-label="Управление картой">
      <button aria-label="Увеличить карту" onClick={() => zoom(1)} type="button"><RaidControlIcon name="plus" /></button>
      <button aria-label="Уменьшить карту" onClick={() => zoom(-1)} type="button"><RaidControlIcon name="minus" /></button>
      <button aria-label="Показать моё местоположение" aria-pressed={following} className="raid-map-controls__follow" disabled={!location || provider !== 'ready'} onClick={() => setFollowing(current => !current)} type="button"><RaidControlIcon name="location" /></button>
    </nav>
    {provider === 'loading' && <p className="route-live-map__state" role="status">Загружаем карту…</p>}
    {provider === 'failed' && <p className="route-live-map__state route-live-map__state--error" role="alert">Карта не загрузилась.{live ? ' Трек продолжает записываться.' : ' Проверьте соединение и откройте рейд снова.'}</p>}
    {provider === 'ready' && dataState === 'loading' && <p className="route-live-map__state" role="status">Открываем точки рейда…</p>}
    {provider === 'ready' && dataState === 'failed' && !track && <p className="route-live-map__state route-live-map__state--error" role="alert">Не удалось загрузить карту рейда. Повторим автоматически.</p>}
    {track?.truncated && <p className="route-live-map__state route-live-map__state--notice">Подгружаем продолжение длинного трека…</p>}
  </div>
}