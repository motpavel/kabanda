import { pointProgressSchema, type PointProgress } from '@kabanda/contracts/exploration'
import { requestJson } from '../../lib/http'

export type VisitState = 'unknown' | 'personal' | 'team' | 'unvisited'
export type PointVisitProgress = { visitState: VisitState; personalCount: number | null; teamCount: number | null; historyPointId: string | null }

export async function fetchPointProgress(team: string, category: PointProgress['category'], collection?: string | null): Promise<PointProgress> {
  const query = new URLSearchParams({ category })
  if (category === 'attractions' && collection) query.set('collection', collection)
  const data = pointProgressSchema.parse(await requestJson(`/api/kabandas/${encodeURIComponent(team)}/points/progress?${query}`))
  if (data.category !== category || data.collectionId !== (category === 'attractions' ? collection ?? null : null)) throw new Error('Point progress scope mismatch')
  return data
}

export function pointVisitProgress(data: PointProgress | null, point: { id: string; stableId: string }): PointVisitProgress {
  const match = data?.points.find(item => item.stableId === point.stableId && (data.category === 'stores' || item.pointId === point.id))
  // No row is NOT a negative visit result: a changed catalog or a bounded page
  // can omit a point. The server returns explicit zero rows for known stores.
  if (!match) return { visitState: 'unknown', personalCount: null, teamCount: null, historyPointId: null }
  return {
    visitState: match.personalCount > 0 ? 'personal' : match.teamCount > 0 ? 'team' : 'unvisited',
    personalCount: match.personalCount, teamCount: match.teamCount, historyPointId: match.pointId,
  }
}

export function visitStateLabel(state: VisitState): string {
  return { unknown: 'Посещения пока неизвестны', personal: 'Вы были здесь', team: 'Кабанда была здесь', unvisited: 'Ещё не посещали' }[state]
}
