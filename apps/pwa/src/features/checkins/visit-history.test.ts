import { describe, expect, it } from 'vitest'
import type { PointVisitHistory } from '@kabanda/contracts'
import { formatVisitCount, visitsForParticipant } from './visit-history'

describe('visits grouped by participant', () => {
  it('keeps separate repeats from one raid, filters others, deduplicates pages and uses each visit time', () => {
    const visits = [
      { id: 'first', userId: 'anya', displayName: 'Аня', visitedAt: '2026-09-01T10:00:00Z', source: 'gps' },
      { id: 'second', userId: 'anya', displayName: 'Аня', visitedAt: '2026-09-01T11:00:00Z', source: 'gps' },
      { id: 'other', userId: 'misha', displayName: 'Михаил', visitedAt: '2026-09-01T12:00:00Z', source: 'gps' },
    ]
    const entry: PointVisitHistory['entries'][number] = { id: 'raid', raidId: 'raid', title: 'По центру', state: 'active', visitedAt: visits[2]!.visitedAt, mine: false, personalVisits: 0, visits, participants: [] }
    expect(visitsForParticipant([entry, entry], 'anya')).toEqual([
      { id: 'second', raidId: 'raid', title: 'По центру', visitedAt: visits[1]!.visitedAt },
      { id: 'first', raidId: 'raid', title: 'По центру', visitedAt: visits[0]!.visitedAt },
    ])
  })
  it.each([[0, '0 раз'], [1, '1 раз'], [3, '3 раза'], [5, '5 раз'], [12, '12 раз'], [22, '22 раза'], [114, '114 раз']])('formats %s visits', (count, label) => {
    expect(formatVisitCount(count as number)).toBe(label)
  })
})
