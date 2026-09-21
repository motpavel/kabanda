import { describe, expect, it } from 'vitest'
import { newPersonalVisit } from './visit-notifications'
import type { RaidMapPoint } from '../raids/types'
const point = (attempt: string | null): RaidMapPoint => ({ id: 'point', sourcePointId: 'source', name: 'Озеро', latitude: 1, longitude: 1, position: 0, visitedByMe: Boolean(attempt), visitedByTeam: true, myLastVisitAttemptId: attempt })
describe('confirmed personal visit notifications', () => {
  it('does not replay historical attendance on first snapshot', () => {
    expect(newPersonalVisit([point('old')], null).point).toBeNull()
  })
  it('notifies first attendance and subsequent visits even when visitedByMe remains true', () => {
    const initial = newPersonalVisit([point(null)], null)
    const first = newPersonalVisit([point('first')], initial.next)
    expect(first.point?.myLastVisitAttemptId).toBe('first')
    expect(newPersonalVisit([point('second')], first.next).point?.myLastVisitAttemptId).toBe('second')
  })
  it('does not duplicate unchanged snapshots or announce somebody else’s visit', () => {
    const first = newPersonalVisit([point('first')], null)
    expect(newPersonalVisit([{ ...point('first'), lastAttemptId: 'someone-else' }], first.next).point).toBeNull()
    expect(newPersonalVisit([point('first')], first.next).point).toBeNull()
  })
})
