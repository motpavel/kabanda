import { useCallback, useMemo } from 'react'
import { raidResource, useRaidResource } from './resources'
import { useRecordingLeaveGuard } from './recording/leave-guard'
import type { RaidProjection } from './types'

export function useRaidProjection(identityId: string, raidId: string, staleOnly = false) {
  const entry = useMemo(() => raidResource(identityId, raidId), [identityId, raidId])
  const completed = entry.state.data?.state === 'completed'
  const resource = useRaidResource(entry, !staleOnly, completed ? 60_000 : 5_000, completed ? 60_000 : 0)
  useRecordingLeaveGuard(identityId, resource.data)
  const applyRaid = useCallback(async (raid: RaidProjection) => {
    // Command responses have already been published by the API before resolving.
    // Ignore a callback belonging to an old identity or an unmounted raid.
    if (raid.id !== raidId || (entry.state.data && entry.state.data.version > raid.version)) return
    if (!entry.state.data || entry.state.data.version < raid.version) entry.accept(raid)
    await entry.settled()
  }, [entry, raidId])
  return { raid: resource.data, stale: staleOnly || resource.status !== 'ready', savedAt: resource.savedAt,
    loading: resource.status === 'loading', error: resource.message, refresh: resource.refresh, applyRaid }
}
