import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchRecoveringPosition } from './gps-watch'

describe('five-second GPS polling and recovery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  function setup() {
    const callbacks: Array<{ success: PositionCallback; failure: PositionErrorCallback }> = []
    const geo = { getCurrentPosition: vi.fn((success: PositionCallback, failure: PositionErrorCallback) => {
      callbacks.push({ success, failure })
    }) } as unknown as Geolocation
    const success = vi.fn(), failure = vi.fn()
    const stop = watchRecoveringPosition(geo, success, failure)
    const fail = (code: number, index = callbacks.length - 1) => callbacks[index]!.failure({ code, message: '', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 })
    const fix = (age = 0, accuracy = 8, index = callbacks.length - 1) => callbacks[index]!.success({ timestamp: Date.now() - age, coords: { latitude: 56.86, longitude: 53.21, accuracy } } as GeolocationPosition)
    return { callbacks, geo, success, failure, stop, fail, fix }
  }
  it('requests immediately, then only five seconds after each completed fix', () => {
    const gps = setup()
    gps.fix()
    vi.advanceTimersByTime(4999)
    expect(gps.callbacks).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(gps.callbacks).toHaveLength(2)
    vi.advanceTimersByTime(7000) // Slow provider: no overlapping request.
    expect(gps.callbacks).toHaveLength(2)
    gps.fix()
    expect(gps.success).toHaveBeenCalledTimes(2)
    gps.stop()
  })
  it('backs off transient errors and resets after a usable fix', () => {
    const gps = setup()
    for (const delay of [5000, 10000, 20000, 30000]) {
      const count = gps.callbacks.length
      gps.fail(2); gps.fail(3)
      vi.advanceTimersByTime(delay)
      expect(gps.callbacks).toHaveLength(count + 1)
    }
    gps.fix()
    vi.advanceTimersByTime(5000)
    const count = gps.callbacks.length
    gps.fail(2)
    vi.advanceTimersByTime(5000)
    expect(gps.callbacks).toHaveLength(count + 1)
    gps.stop()
  })
  it('recovers from a silent provider and ignores its late callback', () => {
    const gps = setup()
    vi.advanceTimersByTime(25000)
    expect(gps.failure).toHaveBeenCalledOnce()
    expect(gps.callbacks).toHaveLength(2)
    gps.fix(0, 8, 0)
    expect(gps.success).not.toHaveBeenCalled()
    gps.fix()
    expect(gps.success).toHaveBeenCalledOnce()
    gps.stop()
  })
  it('discards old and inaccurate coordinates, then accepts a fresh fix', () => {
    const gps = setup()
    gps.fix(30000)
    vi.advanceTimersByTime(5000)
    gps.fix(0, 150)
    vi.advanceTimersByTime(5000)
    expect(gps.success).not.toHaveBeenCalled()
    gps.fix()
    expect(gps.success).toHaveBeenCalledOnce()
    gps.stop()
  })
  it('stops on denial and ignores callbacks after hiding; a new recorder polls immediately', () => {
    const denied = setup()
    denied.fail(1)
    vi.advanceTimersByTime(120000)
    expect(denied.callbacks).toHaveLength(1)
    const hidden = setup()
    hidden.stop(); hidden.fix()
    vi.advanceTimersByTime(120000)
    expect(hidden.success).not.toHaveBeenCalled()
    expect(hidden.callbacks).toHaveLength(1)
    const resumed = setup()
    expect(resumed.callbacks).toHaveLength(1)
    resumed.fix()
    expect(resumed.success).toHaveBeenCalledOnce()
    resumed.stop()
  })
})
