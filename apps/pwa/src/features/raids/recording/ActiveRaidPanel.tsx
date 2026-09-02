import type { RaidPrimaryAction } from '../state'
import type { RaidProjection } from '../types'
import { selectActivePrimaryAction } from './state'
import { useRouteRecorder } from './useRouteRecorder'
import { CheckInPanel } from '../../checkins/CheckInPanel'
import { FinishRaidPanel } from '../../results/FinishRaidPanel'
import { RaidRouteMap } from './RaidRouteMap'

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
  return (
    <>
    <RaidRouteMap raidId={raid.id} live={raid.state === 'active'} />
    {raid.state === 'active' && <CheckInPanel identityId={identityId} raid={raid} staleProjection={staleProjection} onCanonicalRefresh={onCanonicalRefresh} />}
    {(recorder.message || primary === 'recover' || (primary === 'server' && serverPrimary)) && <section aria-label="Управление записью маршрута" className="kb-card route-recorder" data-phase={recorder.phase}>
      {recorder.message && <p className="kb-error" role="alert">{recorder.message}</p>}
      {primary === 'recover' && (
        <button className={raid.state === 'active' ? 'kb-link-button route-recorder__secondary' : 'kb-primary raid-primary'} type="button" onClick={recorder.recover}>
          {recorder.phase === 'standby' ? 'Продолжить здесь' : 'Возобновить запись'}
        </button>
      )}
      {primary === 'server' && serverPrimary && (
        <button className={raid.state === 'active' ? 'kb-link-button route-recorder__secondary' : 'kb-primary raid-primary'} type="button" disabled={operationPending} onClick={onServerPrimary}>
          {operationPending ? 'Подтверждаем…' : serverPrimary.label}
        </button>
      )}
    </section>}
    {(raid.state === 'active' || raid.state === 'paused') && (
      <FinishRaidPanel
        identityId={identityId}
        raid={raid}
        flushRoute={recorder.flush}
        onApplyRaid={onApplyRaid}
        onCanonicalRefresh={onCanonicalRefresh}
      />
    )}
    </>
  )
}
