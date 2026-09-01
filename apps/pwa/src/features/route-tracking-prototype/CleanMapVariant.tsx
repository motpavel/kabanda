import { RouteSimulationMap } from './RouteSimulationMap'
import { useRoutePlayback } from './useRoutePlayback'

export function CleanMapVariant() {
  const playback = useRoutePlayback()
  return (
    <main className="route-proto route-proto--clean">
      <RouteSimulationMap traveled={playback.traveled} />
      <header className="route-proto-brand"><img src={`${import.meta.env.BASE_URL}brand/kabanda-logo-reference.png`} alt="" /><strong>КАБАНДА</strong></header>
      <section className="route-proto-compact" aria-label="Следующая точка">
        <span>Следующая</span>
        <strong>пл. 50-летия Октября, 5</strong>
        <small>{Math.round(playback.remainingDistanceM)} м · примерно 4 мин</small>
      </section>
      <button className="route-proto-floating-control" type="button" onClick={playback.toggle}>
        {playback.completed ? 'Ещё раз' : playback.playing ? 'Пауза' : 'Продолжить'}
      </button>
    </main>
  )
}
