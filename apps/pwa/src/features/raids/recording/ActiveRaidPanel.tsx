import type { RaidPrimaryAction } from '../state'
import type { RaidProjection } from '../types'
import { routeStatusLabel, selectActivePrimaryAction, wakeLockLabel } from './state'
import { useRouteRecorder } from './useRouteRecorder'

export function ActiveRaidPanel({
  identityId,
  raid,
  staleProjection,
  serverPrimary,
  operationPending,
  onServerPrimary,
  onCanonicalRefresh,
  onApplyRaid,
}: {
  identityId: string
  raid: RaidProjection
  staleProjection: boolean
  serverPrimary: RaidPrimaryAction | null
  operationPending: boolean
  onServerPrimary: () => void
  onCanonicalRefresh: () => Promise<unknown>
  onApplyRaid: (raid: RaidProjection) => Promise<unknown>
}) {
  const recorder = useRouteRecorder({ identityId, raid, staleProjection, onCanonicalRefresh, onApplyRaid })
  const serverActionAvailable = serverPrimary?.kind === 'command' || serverPrimary?.kind === 'refresh'
  const primary = selectActivePrimaryAction(recorder.phase, serverActionAvailable)
  const lastSample = recorder.lastPersistedSampleAt
    ? new Date(recorder.lastPersistedSampleAt).toLocaleTimeString('ru-RU')
    : 'ещё нет'
  const distance = recorder.preliminaryDistanceM >= 1_000
    ? `${(recorder.preliminaryDistanceM / 1_000).toFixed(2)} км`
    : `${Math.round(recorder.preliminaryDistanceM)} м`

  return (
    <section className="kb-card route-recorder" data-phase={recorder.phase}>
      <div className="kb-section-head">
        <div><p className="kb-kicker">Маршрут навигатора</p><h2>{routeStatusLabel(recorder.phase)}</h2></div>
        <span className={`route-recorder__signal route-recorder__signal--${recorder.phase}`}>
          {recorder.phase === 'fresh' ? 'fresh' : recorder.phase}
        </span>
      </div>
      <p className="kb-muted">
        GPS пишет только эта видимая страница. Выключенный экран и фон не считаются поддержанными без полевого evidence.
      </p>
      <div className="route-recorder__metrics">
        <div><span>Последний sample</span><strong>{lastSample}</strong></div>
        <div><span>Локально ждут receipt</span><strong>{recorder.pendingCount}</strong></div>
        <div><span>Предварительно на устройстве</span><strong>≈ {distance}</strong></div>
        <div><span>Принято сервером</span><strong>{recorder.routeStatus.acceptedSampleCount}</strong></div>
      </div>
      <p className={`route-recorder__wake route-recorder__wake--${recorder.wakeLock}`}>
        {wakeLockLabel(recorder.wakeLock)}. Это не обещание фонового GPS.
      </p>
      {recorder.message && <p className="kb-error" role="alert">{recorder.message}</p>}
      {primary === 'recover' && (
        <button className="kb-primary raid-primary" type="button" onClick={recorder.recover}>
          {recorder.phase === 'standby' ? 'Продолжить здесь' : 'Возобновить запись'}
        </button>
      )}
      {primary === 'server' && serverPrimary && (
        <button className="kb-primary raid-primary" type="button" disabled={operationPending} onClick={onServerPrimary}>
          {operationPending ? 'Подтверждаем…' : serverPrimary.label}
        </button>
      )}
    </section>
  )
}
