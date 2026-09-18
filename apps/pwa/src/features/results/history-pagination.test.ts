import { describe, expect, it, vi } from 'vitest'
import type { HistoryEntry, HistoryPage } from '@kabanda/contracts/exploration'
import { isHistoryWindow, loadHistoryWindow } from './history-pagination'
const metrics = { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0 }
const entry = (n: number): HistoryEntry => ({ raidId: `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`, title: String(n), completedAt: '2026-09-18T12:00:00Z', partial: false, participated: true, team: metrics, personal: metrics })
const page = (ids: number[], nextCursor: string | null): HistoryPage => ({ schemaVersion: 2, scope: 'mine', raids: ids.map(entry), nextCursor })

describe('bounded history window', () => {
  it('loads only requested pages and deduplicates without inferring participation from metrics', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page([1, 2], 'next')).mockResolvedValueOnce(page([2, 3], 'later'))
    const result = await loadHistoryWindow('team', 'mine', 2, () => true, fetch)
    expect(result.raids.map(row => row.raidId)).toEqual([entry(1).raidId, entry(2).raidId, entry(3).raidId])
    expect(result.nextCursor).toBe('later')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result.raids.every(row => row.participated && row.personal.distanceMeters === 0)).toBe(true)
  })
  it('rejects a failed later page instead of publishing an incomplete successful window', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page([1], 'next')).mockRejectedValueOnce(new Error('offline'))
    await expect(loadHistoryWindow('team', 'mine', 2, () => true, fetch)).rejects.toThrow('offline')
  })
  it('stops requesting more pages after its generation is invalidated', async () => {
    let current = true
    const fetch = vi.fn().mockImplementation(async () => { current = false; return page([1], 'next') })
    await expect(loadHistoryWindow('team', 'mine', 5, () => current, fetch)).rejects.toThrow('superseded')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('refuses a non-advancing cursor and a different filter', async () => {
    const fetch = vi.fn().mockResolvedValue(page([1], 'same'))
    await expect(loadHistoryWindow('team', 'mine', 5, () => true, fetch)).rejects.toThrow('advance')
    expect(fetch).toHaveBeenCalledTimes(2)
    await expect(loadHistoryWindow('team', 'all', 1, () => true, fetch)).rejects.toThrow('scope')
  })
  it('validates successful empty snapshots but not metric-based or foreign-scope data', () => {
    expect(isHistoryWindow({ ...page([], null), pageCount: 1 })).toBe(true)
    expect(isHistoryWindow({ ...page([1], null), pageCount: 1 })).toBe(true)
    expect(isHistoryWindow({ ...page([1], null), raids: [{ ...entry(1), participated: false }], pageCount: 1 })).toBe(false)
    expect(isHistoryWindow({ ...page([1, 1], null), pageCount: 1 })).toBe(false)
  })
})
