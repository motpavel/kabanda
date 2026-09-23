import { describe, expect, it, vi } from 'vitest'
import { canWarmHistory, createHistoryWarmupQueue, nearbyHistoryIds } from './history-warmup'

describe('nearby history warmup', () => {
  const points = Array.from({ length: 100 }, (_, index) => ({ id: String(index), latitude: 56 + index / 1000, longitude: 53 }))
  it('bounds reads to three unique nearest canonical points and prioritizes the selection', () => {
    expect(nearbyHistoryIds([...points, points[0]!], points[0], '99')).toEqual(['99', '0', '1'])
    expect(nearbyHistoryIds(points, points[50])).toEqual(['50', '49', '51'])
    expect(nearbyHistoryIds([{ id: 'bad', latitude: NaN, longitude: 53 }, ...points], points[0])).toEqual(['0', '1', '2'])
  })
  it('does not guess the nearest points without a position, but can warm an explicit destination', () => {
    expect(nearbyHistoryIds(points)).toEqual([])
    expect(nearbyHistoryIds(points, null, '4')).toEqual(['4'])
  })
  it('leaves bandwidth for foreground tiles on constrained connections', () => {
    expect(canWarmHistory(true, true)).toBe(true)
    expect(canWarmHistory(false, true)).toBe(false)
    expect(canWarmHistory(true, false)).toBe(false)
    for (const connection of [{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }, { effectiveType: '3g' }, { downlink: .5 }]) {
      expect(canWarmHistory(true, true, connection)).toBe(false)
    }
  })
  it('serializes maps, drops cancelled queued reads, and shares the running read until it finishes', async () => {
    const enqueue = createHistoryWarmupQueue()
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const first = vi.fn(() => pending), obsolete = vi.fn(async () => undefined), current = vi.fn(async () => undefined)
    let allowed = true
    const one = enqueue(() => true, first)
    const two = enqueue(() => allowed, obsolete)
    const three = enqueue(() => true, current)
    await Promise.resolve()
    expect(first).toHaveBeenCalledOnce(); expect(current).not.toHaveBeenCalled()
    allowed = false; finish()
    await Promise.all([one, two, three])
    expect(obsolete).not.toHaveBeenCalled(); expect(current).toHaveBeenCalledOnce()
  })
  it('keeps the queue usable after a rejected read', async () => {
    const enqueue = createHistoryWarmupQueue(), next = vi.fn(async () => undefined)
    await enqueue(() => true, async () => { throw new Error('offline') })
    await enqueue(() => true, next)
    expect(next).toHaveBeenCalledOnce()
  })
})
