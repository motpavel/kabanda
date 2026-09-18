import { describe, expect, it, vi } from 'vitest'
import type { HistoryEntry, HistoryPage } from '@kabanda/contracts/exploration'
import { HISTORY_PAGE_SIZE, isHistoryWindow, loadHistoryWindow } from './history-pagination'

const metrics = { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0 }
const entry = (n: number): HistoryEntry => ({
  raidId: `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`,
  title: `Рейд ${n}`, completedAt: '2026-09-18T12:00:00Z', partial: false,
  participated: true, team: metrics, personal: metrics,
})
const page = (ids: number[], nextCursor: string | null): HistoryPage => ({
  schemaVersion: 2, scope: 'mine', raids: ids.map(entry), nextCursor,
})

describe('history page protocol', () => {
  it('rejects an empty non-terminal page instead of treating it as confirmed empty history', async () => {
    const fetch = vi.fn().mockResolvedValue(page([], 'next'))
    await expect(loadHistoryWindow('team', 'mine', 1, () => true, fetch)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(isHistoryWindow({ ...page([], 'next'), pageCount: 1 })).toBe(false)
  })

  it('rejects a page larger than the requested window size', async () => {
    const fetch = vi.fn().mockResolvedValue(page(Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, i) => i + 1), null))
    await expect(loadHistoryWindow('team', 'mine', 1, () => true, fetch)).rejects.toThrow()
  })

  it('rejects duplicates within one page but tolerates overlap at page boundaries', async () => {
    await expect(loadHistoryWindow('team', 'mine', 1, () => true,
      vi.fn().mockResolvedValue(page([1, 1], null)))).rejects.toThrow()
    const fetch = vi.fn().mockResolvedValueOnce(page([1, 2], 'next')).mockResolvedValueOnce(page([2, 3], null))
    const result = await loadHistoryWindow('team', 'mine', 2, () => true, fetch)
    expect(result.raids.map(row => row.raidId)).toEqual([entry(1).raidId, entry(2).raidId, entry(3).raidId])
  })

  it('stops when cursors rotate but no new raid is returned', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(page([1], 'first'))
      .mockResolvedValueOnce(page([1], 'second'))
      .mockResolvedValueOnce(page([1], 'third'))
    await expect(loadHistoryWindow('team', 'mine', 3, () => true, fetch)).rejects.toThrow('advance')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('validates participation in each page, not just the initial response', async () => {
    const absent = { ...page([2], null), raids: [{ ...entry(2), participated: false }] }
    const fetch = vi.fn().mockResolvedValueOnce(page([1], 'next')).mockResolvedValueOnce(absent)
    await expect(loadHistoryWindow('team', 'mine', 2, () => true, fetch)).rejects.toThrow('scope')
  })

  it('allows a genuinely empty history and an empty terminal page', async () => {
    const empty = await loadHistoryWindow('team', 'mine', 4, () => true, vi.fn().mockResolvedValue(page([], null)))
    expect(empty).toMatchObject({ raids: [], nextCursor: null, pageCount: 1 })
    expect(isHistoryWindow(empty)).toBe(true)
    const fetch = vi.fn().mockResolvedValueOnce(page([1], 'next')).mockResolvedValueOnce(page([], null))
    const result = await loadHistoryWindow('team', 'mine', 3, () => true, fetch)
    expect(result.raids).toEqual([entry(1)])
    expect(result.nextCursor).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
