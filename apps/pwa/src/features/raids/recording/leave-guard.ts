import { useLayoutEffect } from 'react'
import { registerNavigationGuard } from '../../../app/navigation-history'
import type { RaidProjection } from '../types'
import type { RecorderPhase } from './types'
import { useRecordingRuntime } from './runtime'

export function recorderNeedsLeaveWarning(identityId: string, raid: Pick<RaidProjection, 'state' | 'navigatorUserId'> | null, phase: RecorderPhase): boolean {
  return raid?.state === 'active' && raid.navigatorUserId === identityId &&
    ['fresh', 'waiting', 'recovering', 'stale'].includes(phase)
}
export function useRecordingLeaveGuard(identityId: string, raid: RaidProjection | null) {
  const { phase } = useRecordingRuntime()
  const enabled = recorderNeedsLeaveWarning(identityId, raid, phase)
  const raidId = raid?.id
  useLayoutEffect(() => {
    if (!enabled || !raidId) return
    const path = window.location.pathname
    return registerNavigationGuard({
      shouldBlock: url => url.origin !== window.location.origin || url.pathname !== path || url.searchParams.get('raid') !== raidId,
      message: 'Если уйти с карты, запись маршрута на этом телефоне остановится. Уже сохранённые точки останутся на телефоне. Сам рейд не завершится. Уйти с карты?',
    })
  }, [enabled, raidId])
}
