import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FieldSyncScheduler, type FieldWork } from './field-scheduler'

const work = (kind: FieldWork['kind'], raidId = 'raid-a'): FieldWork => ({
  operationId: `${raidId}-${kind}`, raidId, kind, status: 'pending', createdAt: 1, nextAttemptAt: 0, claimUntil: 0,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const owners: FieldSyncScheduler[] = []
const owner = (dependencies: ConstructorParameters<typeof FieldSyncScheduler>[0]) => {
  const scheduler = new FieldSyncScheduler(dependencies); owners.push(scheduler); return scheduler
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000) })
afterEach(() => { for (const scheduler of owners.splice(0)) scheduler.stop(); vi.useRealTimers() })

describe('app-scoped field lane clocks', () => {
  it('automatically retries a failed visit on its own deadline while the photograph never resolves', async () => {
    let rows = [work('team'), work('photo')], attempts = 0
    const photo = deferred<void>()
    const pump = vi.fn(async (_raid: string, lane: 'team' | 'materials') => {
      if (lane === 'materials') {
        rows[1] = { ...rows[1]!, status: 'sending', claimUntil: Date.now() + 180000 }
        await photo.promise
        rows = rows.filter(row => row.kind !== 'photo')
      } else if (++attempts === 1) {
        rows[0] = { ...rows[0]!, status: 'retryable', nextAttemptAt: Date.now() + 2000 }
      } else rows = rows.filter(row => row.kind !== 'team')
    })
    const scheduler = owner({ read: async () => [...rows], pump, available: () => true })
    scheduler.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(2)
    expect(rows).toEqual([expect.objectContaining({ kind: 'photo', status: 'sending' })])
    expect(pump.mock.calls.filter(([, lane]) => lane === 'materials')).toHaveLength(1)
    photo.resolve(); await vi.advanceTimersByTimeAsync(0)
  })

  it('can service another raid while the earlier visit is waiting for retry', async () => {
    let rows = [{ ...work('team'), status: 'retryable' as const, nextAttemptAt: Date.now() + 5000 }, work('team', 'raid-b')]
    const pump = vi.fn(async (raidId: string) => { rows = rows.filter(row => row.raidId !== raidId) })
    owner({ read: async () => rows, pump, available: () => true }).wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(pump.mock.calls[0]?.[0]).toBe('raid-b')
    await vi.advanceTimersByTimeAsync(5000)
    expect(pump.mock.calls.map(([id]) => id)).toEqual(['raid-b', 'raid-a'])
  })

  it('pauses without a busy loop offline and immediately resumes due work', async () => {
    let available = false, rows = [work('team')]
    const read = vi.fn(async () => rows)
    const pump = vi.fn(async () => { rows = [] })
    const scheduler = owner({ read, pump, available: () => available })
    scheduler.wake(); await vi.advanceTimersByTimeAsync(300_000)
    expect(read).not.toHaveBeenCalled(); expect(pump).not.toHaveBeenCalled()
    available = true; scheduler.wake(); await vi.advanceTimersByTimeAsync(0)
    expect(pump).toHaveBeenCalledTimes(1)
    available = false; scheduler.wake(); await vi.advanceTimersByTimeAsync(300_000)
    expect(pump).toHaveBeenCalledTimes(1)
  })

  it('does not duplicate a pending write after repeated focus/queue notifications', async () => {
    let rows = [work('team')]
    const response = deferred<void>()
    const pump = vi.fn(async () => { await response.promise; rows = [] })
    const scheduler = owner({ read: async () => rows, pump, available: () => true })
    scheduler.wake(); await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 20; i++) scheduler.wake()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pump).toHaveBeenCalledTimes(1)
    response.resolve(); await vi.advanceTimersByTimeAsync(1000)
    expect(pump).toHaveBeenCalledTimes(1)
  })

  it('never steals a live cross-tab claim before its expiry', async () => {
    let rows = [{ ...work('team'), status: 'sending' as const, claimUntil: Date.now() + 180000 }]
    const pump = vi.fn(async () => { rows = [] })
    owner({ read: async () => rows, pump, available: () => true }).wake()
    await vi.advanceTimersByTimeAsync(179999)
    expect(pump).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(pump).toHaveBeenCalledTimes(1)
  })

  it('does not schedule the next visit after identity-owner disposal, but lets the submitted write finish', async () => {
    let rows = [work('team')]
    const response = deferred<void>()
    const pump = vi.fn(async () => { await response.promise; rows = [work('team', 'raid-b')] })
    const scheduler = owner({ read: async () => rows, pump, available: () => true })
    scheduler.wake(); await vi.advanceTimersByTimeAsync(0)
    scheduler.stop(); response.resolve(); await vi.advanceTimersByTimeAsync(300000)
    expect(pump).toHaveBeenCalledTimes(1)
  })

  it('does not start a write from an old read that resolves after disposal', async () => {
    const read = deferred<FieldWork[]>()
    const pump = vi.fn(async () => {})
    const scheduler = owner({ read: () => read.promise, pump, available: () => true })
    scheduler.wake(); scheduler.stop(); read.resolve([work('team')])
    await vi.advanceTimersByTimeAsync(300000)
    expect(pump).not.toHaveBeenCalled()
  })

  it('backs off a broken local store and recovers without waiting for another UI event', async () => {
    let broken = true, rows = [work('team')]
    const read = vi.fn(async () => { if (broken) throw new Error('disk unavailable'); return rows })
    const pump = vi.fn(async () => { rows = [] })
    const scheduler = owner({ read, pump, available: () => true })
    scheduler.wake(); await vi.advanceTimersByTimeAsync(1999)
    expect(read).toHaveBeenCalledTimes(2)
    broken = false; await vi.advanceTimersByTimeAsync(1)
    expect(pump).toHaveBeenCalledTimes(1)
  })
})
