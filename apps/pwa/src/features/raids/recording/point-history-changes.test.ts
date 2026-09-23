import { describe, expect, it } from 'vitest'
import type { RaidMapPoint } from '../types'
import { changedPointVisits } from './point-history-changes'

const point: RaidMapPoint = { id: 'snapshot', sourcePointId: 'source', name: 'Точка', position: 0,
  latitude: 56.8, longitude: 53.2, visitedByMe: false, visitedByTeam: false }

describe('history invalidation from raid visits', () => {
  it('does not evict history for an initial projection or a new point', () => {
    const first = changedPointVisits([point], null)
    expect(first.changed.size).toBe(0)
    expect(changedPointVisits([point, { ...point, id: 'new', sourcePointId: 'new-source', visitedByTeam: true }], first.next).changed.size).toBe(0)
  })

  it('ignores fresh copies, GPS/coordinates, names, and normalized optional fields', () => {
    const previous = changedPointVisits([point], null).next
    expect(changedPointVisits([{ ...point, latitude: 56.9, name: 'Новое название', lastAttemptId: null }], previous).changed.size).toBe(0)
  })

  it.each([
    { visitedByTeam: true }, { visitedByMe: true }, { lastAttemptId: 'attempt' },
    { myLastVisitAttemptId: 'personal-attempt' }, { lastVisitedAt: '2026-09-23T12:00:00Z' },
  ])('invalidates a changed confirmed visit: %j', change => {
    const previous = changedPointVisits([point], null).next
    const update = changedPointVisits([{ ...point, ...change }], previous)
    expect([...update.changed]).toEqual(['source'])
    expect(changedPointVisits([{ ...point, ...change }], update.next).changed.size).toBe(0)
  })

  it('deduplicates history for different snapshots of the same source point', () => {
    const second = { ...point, id: 'second' }
    const previous = changedPointVisits([point, second], null).next
    const update = changedPointVisits([{ ...point, visitedByTeam: true }, { ...second, visitedByTeam: true }], previous)
    expect([...update.changed]).toEqual(['source'])
  })
})
