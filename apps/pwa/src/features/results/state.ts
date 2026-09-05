import type { FinishLocalReview, RaidMetrics, RaidResult } from './types'

export type FinishPrimary = 'drain' | 'finish' | null

export function pendingInventoryCount(review: FinishLocalReview): number {
  return replayableInventoryCount(review) + review.inventory.needsAction
}

export function replayableInventoryCount(review: FinishLocalReview): number {
  return review.inventory.routePending + review.inventory.checkInsPending + review.inventory.mediaPending
}

export function selectFinishPrimary(
  review: FinishLocalReview,
  partialConfirmed: boolean,
  online: boolean,
): FinishPrimary {
  if (!online) return null
  if (replayableInventoryCount(review) > 0) return partialConfirmed ? 'finish' : 'drain'
  if (review.inventory.needsAction > 0 && !partialConfirmed) return null
  return 'finish'
}

export function finishNeedsPartialConfirmation(review: FinishLocalReview): boolean {
  return pendingInventoryCount(review) > 0
}

export function formatDistance(meters: number): string {
  return meters >= 1_000
    ? `${(meters / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`
    : `${Math.round(meters)} м`
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return hours ? `${hours}:${String(remainder).padStart(2, '0')}` : `${minutes} мин`
}

export function metricRows(personal: RaidMetrics, team: RaidMetrics) {
  return [
    { id: 'distance', label: 'Расстояние', personal: formatDistance(personal.distanceMeters), team: formatDistance(team.distanceMeters) },
    { id: 'duration', label: 'В пути', personal: formatDuration(personal.durationSeconds), team: formatDuration(team.durationSeconds) },
    { id: 'points', label: 'Точки', personal: String(personal.uniquePoints), team: String(team.uniquePoints) },
    { id: 'photos', label: 'Фото', personal: String(personal.photos), team: String(team.photos) },
  ]
}

export function completionSummary(result: RaidResult) {
  // Wall-clock duration includes pauses, unlike the active-time metric below.
  const elapsed = Date.parse(result.raid.completedAt) - Date.parse(result.raid.startedAt)
  const seconds = Math.floor(elapsed / 1000)
  const duration = !Number.isFinite(seconds) || seconds < 0
    ? '—'
    : [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map((part) => String(part).padStart(2, '0')).join(':')
  return [
    { id: 'duration', label: 'время рейда', value: duration },
    { id: 'points', label: 'точек', value: String(result.team.uniquePoints) },
    { id: 'participants', label: 'участников', value: String(result.participants.length) },
    { id: 'distance', label: 'километров', value: (result.team.distanceMeters / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) },
  ]
}
