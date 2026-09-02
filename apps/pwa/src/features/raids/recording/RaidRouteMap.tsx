import { useEffect, useRef, useState } from 'react'
import { loadYandexMaps, type YandexMap, type YandexMapObject } from '../../kabandas/yandex-maps'
import { getRouteTrack } from '../api'
import type { RouteTrackPoint, RouteTrackProjection } from '../types'

const IZHEVSK_CENTER = [56.8528, 53.2045] as const

export function routeTrackView(points: readonly RouteTrackPoint[]) {
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

export function RaidRouteMap({ raidId, live }: { raidId: string; live: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<YandexMap | null>(null)
  const routeObjectsRef = useRef<YandexMapObject[]>([])
  const [providerState, setProviderState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [track, setTrack] = useState<RouteTrackProjection | null>(null)
  const [trackState, setTrackState] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let active = true
    const apiKey = import.meta.env.VITE_YANDEX_MAPS_API_KEY?.trim() ?? ''
    void loadYandexMaps(apiKey).then((runtime) => {
      if (!active) return
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
      routeObjectsRef.current = []
    }
  }, [])

  useEffect(() => {
    let active = true
    let inFlight = false
    const refresh = async () => {
      if (inFlight || !navigator.onLine) return
      inFlight = true
      try {
        const next = await getRouteTrack(raidId)
        if (!active) return
        setTrack((current) => current?.updatedAt === next.updatedAt && current.pointCount === next.pointCount ? current : next)
        setTrackState('ready')
      } catch {
        if (active) setTrackState('failed')
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
    if (providerState !== 'ready' || !map || !track) return
    let disposed = false
    const apiKey = import.meta.env.VITE_YANDEX_MAPS_API_KEY?.trim() ?? ''
    void loadYandexMaps(apiKey).then((runtime) => {
      if (disposed || mapRef.current !== map) return
      for (const object of routeObjectsRef.current) map.geoObjects.remove(object)
      routeObjectsRef.current = []
      const points = track.segments.flat()
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
      const last = points.at(-1)
      if (last) {
        const riderLayout = runtime.templateLayoutFactory.createClass(
          '<span class="route-live-map__rider" aria-label="Положение навигатора рейда"></span>',
        )
        const rider = new runtime.Placemark([last.latitude, last.longitude], {}, {
          iconLayout: riderLayout,
          iconShape: { type: 'Circle', coordinates: [0, 0], radius: 23 },
          hasBalloon: false,
          hasHint: false,
          zIndex: 5,
        })
        routeObjectsRef.current.push(rider)
        map.geoObjects.add(rider)
      }
      const view = routeTrackView(points)
      map.setCenter(view.center, view.zoom, { duration: 320, timingFunction: 'ease-in-out' })
    })
    return () => {
      disposed = true
    }
  }, [providerState, track])

  const pointCount = track?.pointCount ?? 0
  return <section className="route-live-card" aria-label="Пройденный маршрут рейда">
    <div className="route-live-map" ref={containerRef} />
    {providerState === 'loading' && <p className="route-live-map__state" role="status">Загружаем карту…</p>}
    {providerState === 'failed' && <p className="route-live-map__state route-live-map__state--error" role="alert">Карта не загрузилась. Трек продолжает записываться.</p>}
    {providerState === 'ready' && trackState === 'loading' && <p className="route-live-map__state" role="status">Загружаем пройденный маршрут…</p>}
    {providerState === 'ready' && trackState === 'failed' && !track && <p className="route-live-map__state route-live-map__state--error" role="alert">Не удалось загрузить трек. Повторим автоматически.</p>}
    {providerState === 'ready' && trackState === 'ready' && pointCount < 2 && <p className="route-live-map__state">Трек появится, когда навигатор начнёт движение.</p>}
    {track?.truncated && <p className="route-live-map__state route-live-map__state--notice">Показана первая часть длинного трека.</p>}
  </section>
}
