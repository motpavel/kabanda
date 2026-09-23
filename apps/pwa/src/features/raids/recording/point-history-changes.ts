import type { RaidMapPoint } from '../types'

type VisitMarker = { sourcePointId: string; signature: string }
export type PointVisitBaseline = Map<string, VisitMarker>

/** GPS, positions, and new object identities must not evict point history. */
export function changedPointVisits(points: readonly RaidMapPoint[], previous: PointVisitBaseline | null) {
  const next: PointVisitBaseline = new Map()
  const changed = new Set<string>()
  for (const point of points) {
    const marker = { sourcePointId: point.sourcePointId, signature: JSON.stringify([
      point.visitedByMe, point.visitedByTeam, point.lastAttemptId ?? null,
      point.myLastVisitAttemptId ?? null, point.lastVisitedAt ?? null,
    ]) }
    next.set(point.id, marker)
    const old = previous?.get(point.id)
    if (old && old.sourcePointId === marker.sourcePointId && old.signature !== marker.signature) changed.add(point.sourcePointId)
  }
  return { next, changed }
}
