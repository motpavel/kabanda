import { describe, expect, it } from 'vitest'
import { finishNeedsPartialConfirmation, metricRows, pendingInventoryCount, selectFinishPrimary } from './state'

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
})
