import { describe, expect, it } from 'vitest'
import { completionSummary, finishNeedsPartialConfirmation, metricRows, pendingInventoryCount, selectFinishPrimary } from './state'
import type { RaidResult } from './types'

describe('result and finish state', () => {
  it('drains before finish and requires explicit partial confirmation for unresolved work', () => {
    const pending = {
      inventory: { routePending: 2, checkInsPending: 1, mediaPending: 1, needsAction: 0 },
    }
    expect(selectFinishPrimary(pending, false, true)).toBe('drain')
    expect(selectFinishPrimary(pending, true, true)).toBe('finish')
    expect(finishNeedsPartialConfirmation(pending)).toBe(true)
    const needsAction = { inventory: { routePending: 0, checkInsPending: 0, mediaPending: 0, needsAction: 1 } }
    expect(selectFinishPrimary(needsAction, false, true)).toBeNull()
    expect(selectFinishPrimary(needsAction, true, true)).toBe('finish')
    expect(finishNeedsPartialConfirmation(needsAction)).toBe(true)
    expect(pendingInventoryCount(needsAction)).toBe(1)
    expect(selectFinishPrimary({ inventory: { routePending: 0, checkInsPending: 0, mediaPending: 0, needsAction: 0 } }, false, false)).toBeNull()
  })

  it('renders four personal/team metrics without consulting local distance', () => {
    const personal = { durationSeconds: 600, distanceMeters: 1200, uniquePoints: 2, photos: 3 }
    const team = { durationSeconds: 3600, distanceMeters: 8800, uniquePoints: 6, photos: 14 }
    const rows = metricRows(personal, team)
    expect(rows.map(({ id }) => id)).toEqual(['distance', 'duration', 'points', 'photos'])
    expect(rows[0]).toMatchObject({ personal: '1,2 км', team: '8,8 км' })
  })

  it('uses total elapsed time and canonical team totals for the finish artwork', () => {
    const metrics = { durationSeconds: 600, distanceMeters: 32700, uniquePoints: 12, photos: 0 }
    const result: RaidResult = {
      schemaVersion: 1,
      raid: { id: 'raid', kabandaId: 'team', title: 'Test', startedAt: '2026-09-05T10:00:00Z', completedAt: '2026-09-05T11:40:05Z', partial: false },
      team: metrics,
      personal: { ...metrics, distanceMeters: 100, uniquePoints: 1 },
      participants: Array.from({ length: 5 }, (_, index) => ({ userId: String(index), displayName: `Rider ${index}`, metrics })),
    }
    expect(completionSummary(result).map(({ value }) => value)).toEqual(['01:40:05', '12', '5', '32,7'])
    expect(completionSummary({ ...result, raid: { ...result.raid, startedAt: 'invalid' } })[0]?.value).toBe('—')
    expect(completionSummary({ ...result, raid: { ...result.raid, completedAt: '2026-09-05T09:00:00Z' } })[0]?.value).toBe('—')
    expect(completionSummary({ ...result, team: { ...metrics, distanceMeters: 0, uniquePoints: 0 }, participants: [] }).slice(1).map(({ value }) => value)).toEqual(['0', '0', '0'])
  })
})
