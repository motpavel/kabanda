import { describe, expect, it } from 'vitest'
import { isProgressHistoryPage } from './history-api'
import { unseenHistory } from './HistoryBrowser'
import { filterProductionHistory, historyAchievement } from '../raids/production-model'
import { isPointProgressPage, pointVisitPresentation } from '../kabandas/point-progress'
import type { RaidHistoryItem } from './types'

const metrics = { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0 }
const item: RaidHistoryItem = { raidId: 'ride', title: 'Без GPS', completedAt: '2026-09-17T12:00:00Z', partial: false, participated: true, personal: metrics, team: metrics }

describe('history and visit presentation', () => {
  it('includes confirmed participants with zero metrics and excludes explicit nonparticipants', () => {
    expect(filterProductionHistory([item], 'mine')).toEqual([item])
    expect(historyAchievement(item).label).toBe('Вы участвовали')
    expect(filterProductionHistory([{ ...item, participated: false, personal: { ...metrics, photos: 1 } }], 'mine')).toEqual([])
  })
  it('does not accept inferred participation from an old server in the filtered API', () => {
    expect(isProgressHistoryPage({ raids: [item], nextCursor: null }, 'mine')).toBe(true)
    expect(isProgressHistoryPage({ raids: [{ ...item, participated: undefined }], nextCursor: null }, 'mine')).toBe(false)
    expect(isProgressHistoryPage({ raids: [], nextCursor: null }, 'mine')).toBe(true)
    expect(isProgressHistoryPage({}, 'all')).toBe(false)
  })
  it('deduplicates overlapping pages without dropping new records', () => {
    expect(unseenHistory([item, item, { ...item, raidId: 'next' }], ['ride']).map(raid => raid.raidId)).toEqual(['next'])
  })
  it('does not equate unknown visits with a confirmed zero', () => {
    expect(pointVisitPresentation(undefined)).toMatchObject({ visitsKnown: false, historyPointId: null })
    expect(pointVisitPresentation({ stableId: 'store', pointId: null, personalCount: 0, teamCount: 0 })).toMatchObject({ visitsKnown: true, visitedByMe: false, visitedByTeam: false })
    expect(pointVisitPresentation({ stableId: 'store', pointId: 'source', personalCount: 0, teamCount: 2 })).toMatchObject({ visitedByMe: false, visitedByTeam: true, historyPointId: 'source' })
  })
  it('rejects invalid and duplicate point summaries instead of painting them unvisited', () => {
    const point = { stableId: 'a', pointId: 'p', personalCount: 1, teamCount: 1 }
    expect(isPointProgressPage({ points: [point] })).toBe(true)
    expect(isPointProgressPage({ points: [point, point] })).toBe(false)
    expect(isPointProgressPage({ points: [{ ...point, teamCount: 0 }] })).toBe(false)
    expect(isPointProgressPage({})).toBe(false)
  })
})
