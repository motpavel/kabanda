import { describe, expect, it } from 'vitest'
import type { PointProgress } from '@kabanda/contracts/exploration'
import { pointVisitProgress, visitStateLabel } from './point-progress'
const point = { id: 'static-store', stableId: 'stable-store' }
const data = (personalCount: number, teamCount: number): PointProgress => ({ category: 'stores', collectionId: null, complete: true,
  points: [{ pointId: '11111111-1111-4111-8111-111111111111', stableId: point.stableId, personalCount, teamCount }] })
describe('visit-state projection', () => {
  it('never turns missing or truncated data into an unvisited point', () => {
    expect(pointVisitProgress(null, point).visitState).toBe('unknown')
    expect(pointVisitProgress({ ...data(0, 0), points: [], complete: false }, point).personalCount).toBeNull()
    expect(pointVisitProgress({ ...data(0, 0), points: [] }, point).visitState).toBe('unknown')
  })
  it('uses explicit zero, not membership or another participant credit, for personal state', () => {
    expect(pointVisitProgress(data(0, 0), point).visitState).toBe('unvisited')
    expect(pointVisitProgress(data(0, 3), point).visitState).toBe('team')
    expect(pointVisitProgress(data(2, 3), point).visitState).toBe('personal')
  })
  it('maps static store keys to canonical history IDs without mutating the catalog', () => {
    expect(pointVisitProgress(data(1, 1), point).historyPointId).toBe('11111111-1111-4111-8111-111111111111')
    expect(point.id).toBe('static-store')
  })
  it('keeps labels explicit without relying on color alone', () => {
    expect(['unknown', 'personal', 'team', 'unvisited'].map(state => visitStateLabel(state as Parameters<typeof visitStateLabel>[0]))).toEqual([
      'Посещения пока неизвестны', 'Вы были здесь', 'Кабанда была здесь', 'Ещё не посещали',
    ])
  })
})
