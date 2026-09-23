import { useEffect, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { navigateApp } from '../../app/transitions'
import { appPath } from '../../lib/paths'
import { MapCamera } from '../kabandas/map-camera'
import type { DisplayMapRuntime, YandexMap, YandexPlacemark } from '../kabandas/yandex-maps'
import { OfflineMapStatus } from './OfflineMapStatus'
import { loadOfflineMapRuntime } from './runtime'
import './offline-city-map.css'

/** Public streets only. This screen does not load identities, teams or raid data. */
export function OfflineCityMap() {
  // A first visit may come straight to this public URL. Cache the application
  // shell too; keep update activation with the normal recording-aware gate.
  useRegisterSW({ immediate: true })
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<YandexMap | null>(null)
  const cameraRef = useRef<MapCamera | null>(null)
  const runtimeRef = useRef<DisplayMapRuntime | null>(null)
  const locationMarker = useRef<YandexPlacemark | null>(null)
  const locationRequest = useRef(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [online, setOnline] = useState(() => navigator.onLine !== false)
  const [zoom, setZoom] = useState(12)
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [failureDetail, setFailureDetail] = useState<string | null>(null)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let active = true
    let zoomTimer: ReturnType<typeof setTimeout> | undefined
    const resize = new ResizeObserver(() => mapRef.current?.container?.fitToViewport?.())
    resize.observe(container)
    setStatus('loading')
    setFailureDetail(null)
    setLocationError(null)
    void loadOfflineMapRuntime().then(runtime => {
      if (!active) return
      const map = new runtime.Map(container, { center: [56.8527, 53.2115], zoom: 12, controls: [] })
      mapRef.current = map
      runtimeRef.current = runtime
      cameraRef.current = new MapCamera(map, () => matchMedia('(prefers-reduced-motion: reduce)').matches)
      map.events.add('boundschange', () => {
        clearTimeout(zoomTimer)
        zoomTimer = setTimeout(() => { if (active) setZoom(map.getZoom()) }, 150)
      })
      setZoom(map.getZoom())
      setStatus('ready')
    }).catch(error => {
      if (!active) return
      if (import.meta.env.DEV) console.error('[offline-city-map] Map initialization failed', error)
      const message = error instanceof Error ? error.message : ''
      if (/webgl|web.?gl|graphics context|canvas context/i.test(message)) {
        setFailureDetail('Не удалось запустить карту на этом устройстве. Закройте лишние приложения и попробуйте снова.')
      } else if (message.startsWith('Карта Ижевска ещё не сохранена.')) {
        setFailureDetail('Карта ещё не скачана. Подключитесь к интернету и откройте её один раз.')
      }
      setStatus('error')
    })
    return () => {
      active = false
      locationRequest.current++
      clearTimeout(zoomTimer)
      resize.disconnect()
      cameraRef.current?.stop()
      cameraRef.current = null
      locationMarker.current = null
      runtimeRef.current = null
      mapRef.current?.destroy()
      mapRef.current = null
    }
  }, [attempt])

  function locate() {
    if (!navigator.geolocation) {
      setLocationError('Геолокация недоступна на этом устройстве.')
      return
    }
    const requestedMap = mapRef.current
    if (!requestedMap) return
    const request = ++locationRequest.current
    setLocating(true)
    setLocationError(null)
    navigator.geolocation.getCurrentPosition(position => {
      const map = mapRef.current
      const runtime = runtimeRef.current
      if (!map || !runtime || map !== requestedMap || request !== locationRequest.current) return
      setLocating(false)
      const { latitude, longitude } = position.coords
      if (latitude < 56.7 || latitude > 57 || longitude < 53 || longitude > 53.4) {
        setLocationError('Вы за пределами сохранённой карты Ижевска.')
        return
      }
      const coordinate = [latitude, longitude] as const
      if (locationMarker.current) locationMarker.current.geometry?.setCoordinates(coordinate)
      else {
        locationMarker.current = new runtime.Placemark(coordinate, {}, {
          iconLayout: runtime.templateLayoutFactory.createClass('<span class="kb-yandex-user-location" aria-label="Моё местоположение"></span>'),
          hasBalloon: false, hasHint: false, zIndex: 10,
        })
        map.geoObjects.add(locationMarker.current)
      }
      cameraRef.current?.center(coordinate)
    }, () => {
      if (mapRef.current !== requestedMap || request !== locationRequest.current) return
      setLocating(false)
      setLocationError('Не удалось определить положение. Разрешите геолокацию и повторите.')
    }, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 12_000 })
  }

  return <main className="offline-city-map" aria-label="Офлайн-карта Ижевска">
    <div ref={containerRef} className="offline-city-map__canvas" aria-label="Карта города" />
    <header className="offline-city-map__header">
      <a className="offline-city-map__back" href={appPath('app')} aria-label="Вернуться в приложение" onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        navigateApp(appPath('app'))
      }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg></a>
      <div className="offline-city-map__title"><h1>Ижевск</h1><span>{online ? 'Карта города' : 'Без интернета'}</span></div>
    </header>
    {status === 'loading' && <p className="offline-city-map__notice" role="status">Открываем карту…</p>}
    {status === 'error' && <section className="offline-city-map__notice offline-city-map__notice--error" role="alert">
      <h2>Карта пока недоступна</h2>
      <p>{failureDetail ?? (online ? 'Не удалось открыть карту. Попробуйте ещё раз.' : 'Для первого открытия нужна сеть. Если карта уже скачана, попробуйте открыть её снова.')}</p>
      <button type="button" onClick={() => setAttempt(value => value + 1)}>Повторить</button>
    </section>}
    <div className="offline-city-map__controls" aria-label="Управление картой">
      <button type="button" aria-label="Приблизить" disabled={status !== 'ready' || zoom >= 19} onClick={() => cameraRef.current?.zoom(Math.min(19, (mapRef.current?.getZoom() ?? 12) + 1))}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <button type="button" aria-label="Отдалить" disabled={status !== 'ready' || zoom <= 3} onClick={() => cameraRef.current?.zoom(Math.max(3, (mapRef.current?.getZoom() ?? 12) - 1))}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
      </button>
      <button type="button" aria-label={locating ? 'Определяем местоположение' : 'Показать моё местоположение'} aria-busy={locating} disabled={status !== 'ready' || locating} onClick={locate}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 4-6.5 16-3-6.5L4 10.5 20 4Z" /></svg>
      </button>
    </div>
    <div className="offline-city-map__download">
      {locationError && <p className="offline-city-map__location-error" role="alert">{locationError}</p>}
      <OfflineMapStatus />
    </div>
  </main>
}
