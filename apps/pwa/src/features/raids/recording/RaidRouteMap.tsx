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

export function routeTrackView(points: readonly (Pick<RouteTrackPoint, 'latitude' | 'longitude'> & Partial<Pick<RouteTrackPoint, 'capturedAt'>>)[]) {
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
  const span = Math.max(maxLatitude - minLatitude, maxLongitude - minLongitude)
  const zoom = span > .08 ? 12 : span > .04 ? 13 : span > .02 ? 14 : span > .01 ? 15 : span > .005 ? 16 : 17
  return {
    center: [(minLatitude + maxLatitude) / 2, (minLongitude + maxLongitude) / 2] as const,
    zoom,
  }
}

export function RaidRouteMap({
  raidId,
  live,
  location,
  highlightedPointId,
}: {
  raidId: string
  live: boolean
  location: OneShotCoordinate | null
  highlightedPointId: string | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<YandexMap | null>(null)
  const runtimeRef = useRef<YandexMapsRuntime | null>(null)
  const routeObjectsRef = useRef<YandexMapObject[]>([])
  const pointObjectsRef = useRef<YandexMapObject[]>([])
  const riderRef = useRef<YandexMapObject | null>(null)
  const firstViewApplied = useRef(false)
  const firstLocationApplied = useRef(false)
  const [providerState, setProviderState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [track, setTrack] = useState<RouteTrackProjection | null>(null)
  const [points, setPoints] = useState<RaidMapPoint[]>([])
  const [dataState, setDataState] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let active = true
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
  }, [live, raidId])

  useEffect(() => {
    const map = mapRef.current
    const runtime = runtimeRef.current
    if (providerState !== 'ready' || !map || !runtime || !track) return
    for (const object of routeObjectsRef.current) map.geoObjects.remove(object)
    routeObjectsRef.current = []

    const trackPoints = track.segments.flat()
    for (const segment of track.segments) {
      if (segment.length < 2) continue
      const coordinates = segment.map(({ latitude, longitude }) => [latitude, longitude] as const)
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

    if (!firstViewApplied.current && trackPoints.length > 0) {
      const view = routeTrackView(trackPoints)
      map.setCenter(view.center, view.zoom, { duration: 0 })
      firstViewApplied.current = true
    }
  }, [providerState, track])

  useEffect(() => {
    const map = mapRef.current
    const runtime = runtimeRef.current
    if (providerState !== 'ready' || !map || !runtime) return
    for (const object of pointObjectsRef.current) map.geoObjects.remove(object)
    pointObjectsRef.current = []

    const pointLayout = runtime.templateLayoutFactory.createClass(
      '<span class="{{ properties.markerClass }}" aria-label="{{ properties.ariaLabel }}"></span>',
    )
    for (const point of points) {
      const highlighted = point.id === highlightedPointId
      const markerClass = `raid-live-point${point.visitedByTeam ? ' raid-live-point--visited' : ''}${highlighted ? ' raid-live-point--nearby' : ''}`
      const marker = new runtime.Placemark([point.latitude, point.longitude], {
        markerClass,
        ariaLabel: `${point.name}. ${point.visitedByTeam ? 'Точка закрыта' : highlighted ? 'Вы рядом, подтвердите посещение' : 'Точка рейда'}`,
      }, {
        iconLayout: pointLayout,
        iconShape: { type: 'Circle', coordinates: [0, 0], radius: highlighted ? 22 : 14 },
        hasBalloon: false,
        hasHint: false,
        zIndex: highlighted ? 8 : point.visitedByTeam ? 1 : 4,
      })
      pointObjectsRef.current.push(marker)
      map.geoObjects.add(marker)
    }

    if (!firstViewApplied.current && points.length > 0) {
      const view = routeTrackView(points)
      map.setCenter(view.center, view.zoom, { duration: 0 })
      firstViewApplied.current = true
    }
  }, [highlightedPointId, points, providerState])

  useEffect(() => {
    const map = mapRef.current
    const runtime = runtimeRef.current
    if (providerState !== 'ready' || !map || !runtime) return
    if (riderRef.current) map.geoObjects.remove(riderRef.current)
    riderRef.current = null

    const current = location ?? track?.segments.flat().at(-1) ?? null
    if (!current) return
    const riderLayout = runtime.templateLayoutFactory.createClass(
      '<span class="route-live-map__rider" aria-label="Моё положение"></span>',
    )
    const rider = new runtime.Placemark([current.latitude, current.longitude], {}, {
      iconLayout: riderLayout,
      iconShape: { type: 'Circle', coordinates: [0, 0], radius: 23 },
      hasBalloon: false,
      hasHint: false,
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
  }, [location, providerState, track])

  const changeZoom = (delta: number) => {
    const map = mapRef.current
    if (map) map.setZoom(Math.max(3, Math.min(19, map.getZoom() + delta)), { duration: 180 })
  }

  const centerLocation = () => {
    const map = mapRef.current
    if (map && location) map.setCenter([location.latitude, location.longitude], 15, { duration: 260, timingFunction: 'ease-in-out' })
  }

  return <div className="route-live-map-shell">
    <div className="route-live-map" ref={containerRef} />
    <nav className="raid-map-controls" aria-label="Управление картой">
      <button aria-label="Увеличить карту" onClick={() => changeZoom(1)} type="button">＋</button>
      <button aria-label="Уменьшить карту" onClick={() => changeZoom(-1)} type="button">−</button>
      <button aria-label="Показать моё местоположение" disabled={!location} onClick={centerLocation} type="button">⌖</button>
    </nav>
    {providerState === 'loading' && <p className="route-live-map__state" role="status">Загружаем карту…</p>}
    {providerState === 'failed' && <p className="route-live-map__state route-live-map__state--error" role="alert">Карта не загрузилась. Трек продолжает записываться.</p>}
    {providerState === 'ready' && dataState === 'loading' && <p className="route-live-map__state" role="status">Открываем точки рейда…</p>}
    {providerState === 'ready' && dataState === 'failed' && !track && <p className="route-live-map__state route-live-map__state--error" role="alert">Не удалось загрузить карту рейда. Повторим автоматически.</p>}
    {track?.truncated && <p className="route-live-map__state route-live-map__state--notice">Показана первая часть длинного трека.</p>}
  </div>
}
