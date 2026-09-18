import { useLayoutEffect } from 'react'
import { registerNavigationGuard } from '../../../app/navigation-history'
import { parseRaidRoute } from '../routing'
import type { RaidProjection } from '../types'
import type { RecorderPhase } from './types'
import { useRecordingRuntime } from './runtime'

export function recorderNeedsLeaveWarning(identityId: string, raid: Pick<RaidProjection, 'state' | 'navigatorUserId'> | null, phase: RecorderPhase): boolean {
  return raid?.state === 'active' && raid.navigatorUserId === identityId &&
    ['fresh', 'waiting', 'recovering', 'stale'].includes(phase)
}

/** Use the real route parser: a routeTemplate takes precedence over a raid
 * query parameter, so merely preserving ?raid must not bypass the warning. */
export function recordingNavigationLeavesRaid(destination: URL, current: URL, raidId: string): boolean {
  if (destination.origin !== current.origin || destination.pathname !== current.pathname) return true
  const route = parseRaidRoute(destination.search)
  return route.kind !== 'raid' || route.raidId !== raidId
}

export function useRecordingLeaveGuard(identityId: string, raid: RaidProjection | null) {
  const { phase } = useRecordingRuntime()
  const enabled = recorderNeedsLeaveWarning(identityId, raid, phase)
  const raidId = raid?.id
  useLayoutEffect(() => {
    if (!enabled || !raidId) return
    const current = new URL(window.location.href)
    return registerNavigationGuard({
      shouldBlock: url => recordingNavigationLeavesRaid(url, current, raidId),
      message: 'Если уйти с карты, запись маршрута на этом телефоне остановится. Уже сохранённые точки останутся на телефоне. Сам рейд не завершится. Уйти с карты?',
    })
  }, [enabled, raidId])
}
