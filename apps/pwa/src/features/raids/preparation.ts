import type { RaidPresenceRoster, RaidProjection } from './types'

export function presenceIsCurrent(roster: RaidPresenceRoster | null, now = Date.now()): boolean {
  return Boolean(roster?.allReady && now - Date.parse(roster.serverAt) < roster.maxAgeSeconds * 1000 && roster.participants.every(p => p.status === 'manual' || (p.status === 'nearby' && p.observedAt !== null && now - Date.parse(p.observedAt) < roster.maxAgeSeconds * 1000)))
}

export function canStartPreparedRaid(raid: RaidProjection, userId: string, roster: RaidPresenceRoster | null, online: boolean, stale: boolean, now = Date.now()): boolean {
  return online && !stale && raid.state === 'lobby' && raid.organizerUserId === userId && raid.navigatorReady && presenceIsCurrent(roster, now)
}

export function canCheckLocationAutomatically(permission: PermissionState | undefined, observedAccess: boolean): boolean {
  return permission === 'granted' || (permission === undefined && observedAccess)
}
