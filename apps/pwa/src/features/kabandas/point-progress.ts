import { ApiError, requestJson } from '../../lib/http'

export type PointProgressCategory = 'stores' | 'attractions'
export type PointProgressItem = { stableId: string; pointId: string | null; personalCount: number; teamCount: number }
export type PointProgressPage = { points: PointProgressItem[] }

export function isPointProgressPage(value: unknown): value is PointProgressPage {
  if (!value || typeof value !== 'object' || !Array.isArray((value as PointProgressPage).points)) return false
  const points = (value as PointProgressPage).points
  return points.length <= 500 && points.every(point => point && typeof point.stableId === 'string' &&
    (point.pointId === null || typeof point.pointId === 'string') &&
    Number.isSafeInteger(point.personalCount) && point.personalCount >= 0 &&
    Number.isSafeInteger(point.teamCount) && point.teamCount >= point.personalCount) &&
    new Set(points.map(point => point.stableId)).size === points.length
}

export async function getPointProgress(kabandaId: string, category: PointProgressCategory, pointIds: readonly string[]): Promise<PointProgressPage> {
  const query = new URLSearchParams({ category })
  if (category === 'attractions') query.set('pointIds', [...new Set(pointIds)].sort().join(','))
  const page = await requestJson<unknown>(`/api/kabandas/${encodeURIComponent(kabandaId)}/progress/points?${query}`)
  if (!isPointProgressPage(page)) throw new ApiError('POINT_PROGRESS_INVALID', 'Не удалось проверить посещения.', 502)
  return page
}

export function pointVisitPresentation(progress: PointProgressItem | undefined) {
  return {
    visitsKnown: Boolean(progress),
    historyPointId: progress?.pointId ?? null,
    visitedByMe: (progress?.personalCount ?? 0) > 0,
    visitedByTeam: (progress?.teamCount ?? 0) > 0,
    visitedByMeCount: progress?.personalCount ?? 0,
    visitedByTeamCount: progress?.teamCount ?? 0,
  }
}
