import { useState } from 'react'
import { RouteSimulationMap } from './RouteSimulationMap'
import type { RouteCoordinate } from './simulation'
import { useRoutePlayback } from './useRoutePlayback'

function formatDistance(distanceM: number) {
  if (distanceM < 1_000) return `${Math.round(distanceM / 10) * 10} м`
  return `${(distanceM / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`
}

export function CleanMapVariant() {
  const [route, setRoute] = useState<readonly RouteCoordinate[]>([])
  const [routeStatus, setRouteStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const playback = useRoutePlayback(route)
  const headline = routeStatus === 'loading'
    ? 'Строим маршрут…'
    : routeStatus === 'failed'
      ? 'Маршрут недоступен'
      : playback.completed
        ? 'Точка достигнута'
        : `До точки ${formatDistance(playback.remainingDistanceM)}`

  return (
    <main className="route-proto route-proto--clean">
      <RouteSimulationMap
        current={playback.current}
        onRouteResolved={setRoute}
        onRouteStatusChange={setRouteStatus}
        remaining={playback.remaining}
        traveled={playback.traveled}
      />
      <section className="route-proto-sheet" aria-label="Навигация к следующей точке">
        <div className="route-proto-sheet__handle" aria-hidden="true" />
        <div className="route-proto-sheet__heading">
          <div>
            <p className="route-proto-eyebrow"><span className="route-proto-live-dot" />Велосипедный маршрут · live</p>
            <h1>{headline}</h1>
          </div>
          <span className="route-proto-bike" aria-label="Режим: велосипед">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="5.5" cy="17" r="3.5" />
              <circle cx="18.5" cy="17" r="3.5" />
              <path d="m5.5 17 4-7 3.5 7h-7.5Zm4-7h5l4 7m-7.7-9H8.6m6.8 0h2.3" />
            </svg>
          </span>
        </div>
        <p className="route-proto-destination-name">Следующая точка · пл. 50-летия Октября, 5</p>
        <div className="route-proto-progress" aria-label={`Пройдено ${Math.round(playback.progress * 100)}%`}>
          <span style={{ width: `${Math.max(2, playback.progress * 100)}%` }} />
        </div>
        <div className="route-proto-sheet__metrics">
          <p><span>Осталось</span><strong>{routeStatus === 'ready' ? formatDistance(playback.remainingDistanceM) : '—'}</strong></p>
          <p><span>Скорость</span><strong>{routeStatus === 'ready' ? `${playback.speedKmh} км/ч` : '—'}</strong></p>
          <p><span>Проехали</span><strong>{routeStatus === 'ready' ? formatDistance(playback.traveledDistanceM) : '—'}</strong></p>
        </div>
        <div className="route-proto-lines" aria-label="Обозначения маршрута">
          <span><i className="route-proto-lines__actual" />Проехали</span>
          <span><i className="route-proto-lines__planned" />Осталось</span>
        </div>
      </section>
    </main>
  )
}
