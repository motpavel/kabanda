import type { RaidLiveSnapshot } from '../live-feed'

/** Never infer an unchanged v2 track from frozen result metrics. Combine the live
 * lifecycle revision with route counters; legacy snapshots expose counters. */
export function completedTrackRevision(snapshot: RaidLiveSnapshot | null): string | null {
  if (!snapshot || snapshot.raid.state !== 'completed') return null
  if (snapshot.teamVisits && !snapshot.revision) return null
  return JSON.stringify([snapshot.raid.id, snapshot.raid.version, snapshot.teamVisits === true,
    snapshot.revision ?? null, snapshot.raid.routeStatus])
}
