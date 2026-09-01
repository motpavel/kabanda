import { RouteSimulationMap } from './RouteSimulationMap'
import { useRoutePlayback } from './useRoutePlayback'

export function NavigatorVariant() {
  const playback = useRoutePlayback()
  return (
    <main className="route-proto route-proto--navigator">
      <RouteSimulationMap traveled={playback.traveled} />
      <header className="route-proto-brand"><img src={`${import.meta.env.BASE_URL}brand/kabanda-logo-reference.png`} alt="" /><strong>Рейд идёт</strong><span>GPS пишется</span></header>
      <section className="route-proto-sheet" aria-label="Навигация к следующей точке">
        <div className="route-proto-sheet__handle" aria-hidden="true" />
        <p className="route-proto-eyebrow">Следующая точка · № 3</p>
        <h1>пл. 50-летия Октября, 5</h1>
        <div className="route-proto-progress"><span style={{ width: `${Math.max(2, playback.progress * 100)}%` }} /></div>
        <div className="route-proto-sheet__metrics">
          <p><span>Осталось</span><strong>{Math.round(playback.remainingDistanceM)} м</strong></p>
          <p><span>Скорость</span><strong>{playback.speedKmh} км/ч</strong></p>
          <p><span>Проехали</span><strong>{Math.round(playback.traveledDistanceM)} м</strong></p>
        </div>
        <div className="route-proto-sheet__actions">
          <button type="button" onClick={playback.toggle}>{playback.completed ? 'Проехать ещё раз' : playback.playing ? 'Приостановить' : 'Продолжить'}</button>
          <button type="button" className="route-proto-secondary" onClick={playback.restart}>Сначала</button>
        </div>
      </section>
    </main>
  )
}
