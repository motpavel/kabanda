import { RouteSimulationMap } from './RouteSimulationMap'
import { useRoutePlayback } from './useRoutePlayback'

export function TelemetryVariant() {
  const playback = useRoutePlayback()
  return (
    <main className="route-proto route-proto--telemetry">
      <RouteSimulationMap traveled={playback.traveled} showSamples />
      <header className="route-proto-brand"><img src={`${import.meta.env.BASE_URL}brand/kabanda-logo-reference.png`} alt="" /><strong>Полевой тест</strong><span className="route-proto-live">live</span></header>
      <aside className="route-proto-telemetry" aria-label="Телеметрия маршрута">
        <p className="route-proto-eyebrow">Навигатор · Павел</p>
        <h1>{playback.completed ? 'Точка достигнута' : playback.playing ? 'Маршрут пишется' : 'Запись на паузе'}</h1>
        <dl>
          <div><dt>GPS-сэмплов</dt><dd>{playback.sampleIndex + 1} / 19</dd></div>
          <div><dt>Точность</dt><dd>± {7 + playback.sampleIndex % 4} м</dd></div>
          <div><dt>Скорость</dt><dd>{playback.speedKmh} км/ч</dd></div>
          <div><dt>В очереди</dt><dd>{Math.max(0, (playback.sampleIndex + 1) % 5)} шт.</dd></div>
          <div><dt>Пройдено</dt><dd>{Math.round(playback.traveledDistanceM)} м</dd></div>
        </dl>
        <p className="route-proto-telemetry__note"><i /> Чёрная линия строится только по сохранённым координатам клиента.</p>
        <div className="route-proto-sheet__actions">
          <button type="button" onClick={playback.toggle}>{playback.completed ? 'Повторить тест' : playback.playing ? 'Пауза' : 'Продолжить'}</button>
          <button type="button" className="route-proto-secondary" onClick={playback.restart}>Сбросить</button>
        </div>
      </aside>
    </main>
  )
}
