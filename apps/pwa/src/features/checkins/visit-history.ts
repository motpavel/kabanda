import type { PointVisitHistory } from '@kabanda/contracts'

export function formatVisitCount(count: number): string {
  const lastTwo = count % 100
  return `${count} ${lastTwo >= 11 && lastTwo <= 14 ? 'раз' : count % 10 >= 2 && count % 10 <= 4 ? 'раза' : 'раз'}`
}

export function visitsForParticipant(entries: PointVisitHistory['entries'], userId: string) {
  const seen = new Set<string>()
  return entries.flatMap((entry) => entry.visits.flatMap((visit) => {
    if (visit.userId !== userId || seen.has(visit.id)) return []
    seen.add(visit.id)
    return [{ id: visit.id, raidId: entry.raidId, title: entry.title, visitedAt: visit.visitedAt }]
  })).sort((left, right) => Date.parse(right.visitedAt) - Date.parse(left.visitedAt) || left.id.localeCompare(right.id))
}
