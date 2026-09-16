import { afterEach, describe, expect, it, vi } from 'vitest'
import { coalescedRead, createReadPoller } from './read-refresh'

afterEach(() => vi.useRealTimers())

describe('coalesced resource reads', () => {
  it('shares slow reads across polling and resume, then permits an explicit retry', async () => {
    let finish!: () => void
    const load = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const refresh = coalescedRead(load, () => 0)
    const first = refresh(false)
    expect(refresh(false)).toBe(first)
    expect(refresh()).toBe(first)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    finish(); await first
    await refresh(false)
    expect(load).toHaveBeenCalledTimes(1)
    const retry = refresh()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    finish(); await retry
  })

  it('coalesces a focus/visibility burst and recovers after failure', async () => {
    let time = 0
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const refresh = coalescedRead(load, () => time)
    await expect(refresh(false)).rejects.toThrow('offline')
    time = 500
    await refresh(false)
    expect(load).toHaveBeenCalledTimes(1)
    time = 1_000
    await refresh(false)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('waits the full interval after a slow response, stops when hidden, and does not restart after disposal', async () => {
    vi.useFakeTimers()
    let visible = false
    let finish!: () => void
    const load = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const poller = createReadPoller(coalescedRead(load), () => visible, 5_000)
    await poller.resume()
    expect(load).not.toHaveBeenCalled()
    visible = true
    const first = poller.resume()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(load).toHaveBeenCalledTimes(1)
    finish(); await first
    await vi.advanceTimersByTimeAsync(4_999)
    expect(load).toHaveBeenCalledTimes(1)
    visible = false
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(1)
    visible = true
    const resumed = poller.resume()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    poller.stop()
    finish(); await resumed
    await vi.advanceTimersByTimeAsync(30_000)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
