import type { RaidMapPoint } from '../raids/types'

/** Compare confirmed server event identities, not cumulative visited booleans. */
export function newPersonalVisit(points: readonly RaidMapPoint[], previous: Map<string, string | null> | null) {
  const next = new Map(points.map(point => [point.id, point.myLastVisitAttemptId ?? null]))
  const changed = previous ? points.filter(point => point.myLastVisitAttemptId && previous.get(point.id) !== point.myLastVisitAttemptId) : []
  changed.sort((a, b) => (b.lastVisitedAt ?? '').localeCompare(a.lastVisitedAt ?? ''))
  return { next, point: changed[0] ?? null }
}
