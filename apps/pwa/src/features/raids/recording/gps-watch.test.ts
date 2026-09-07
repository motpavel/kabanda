import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchRecoveringPosition } from './gps-watch'

describe('automatic GPS recovery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  function setup() {
    const callbacks: Array<{ success: PositionCallback; failure: PositionErrorCallback }> = []
    const geo = {
      watchPosition: vi.fn((success: PositionCallback, failure: PositionErrorCallback) => {
        callbacks.push({ success, failure }); return callbacks.length
      }),
      clearWatch: vi.fn(),
    } as unknown as Geolocation
    const success = vi.fn(), failure = vi.fn()
    const stop = watchRecoveringPosition(geo, success, failure)
    const fail = (code: number, index = callbacks.length - 1) => callbacks[index]!.failure({ code, message: '', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 })
    const fix = (age = 0, index = callbacks.length - 1) => callbacks[index]!.success({ timestamp: Date.now() - age, coords: { latitude: 56.86, longitude: 53.21, accuracy: 8 } } as GeolocationPosition)
    return { callbacks, geo, success, failure, stop, fail, fix }
  }
  it('retries transient failures with capped backoff and one live watch', () => {
    const gps = setup()
    for (const delay of [5_000, 10_000, 20_000, 30_000, 30_000]) {
      const count = gps.callbacks.length
      gps.fail(2); gps.fail(3)
      vi.advanceTimersByTime(delay - 1)
      expect(gps.callbacks).toHaveLength(count)
      vi.advanceTimersByTime(1)
      expect(gps.callbacks).toHaveLength(count + 1)
      expect(gps.geo.clearWatch).toHaveBeenLastCalledWith(count)
    }
    gps.stop()
  })
  it('a fresh fix cancels the pending retry and resets backoff', () => {
    const gps = setup()
    gps.fail(2); vi.advanceTimersByTime(3_000); gps.fix()
    vi.advanceTimersByTime(5_000)
    expect(gps.callbacks).toHaveLength(1)
    expect(gps.success).toHaveBeenCalledTimes(1)
    gps.fail(3); vi.advanceTimersByTime(5_000)
    expect(gps.callbacks).toHaveLength(2)
    gps.stop()
  })
  it('restarts a silent watch without needing a user button', () => {
    const gps = setup()
    vi.advanceTimersByTime(20_000)
    expect(gps.failure).toHaveBeenCalledWith(expect.objectContaining({ code: 3 }))
    vi.advanceTimersByTime(5_000)
    expect(gps.callbacks).toHaveLength(2)
    gps.fix()
    expect(gps.success).toHaveBeenCalledTimes(1)
    gps.stop()
  })
  it('ignores stale fixes and late callbacks from a replaced watch', () => {
    const gps = setup()
    gps.fix(30_000)
    gps.fail(2); vi.advanceTimersByTime(5_000)
    gps.fix(0, 0); gps.fail(1, 0)
    expect(gps.success).not.toHaveBeenCalled()
    expect(gps.geo.clearWatch).toHaveBeenCalledTimes(1)
    gps.fix()
    expect(gps.success).toHaveBeenCalledTimes(1)
    gps.stop()
  })
  it('denial stops retrying; cleanup also cancels every future attempt', () => {
    const denied = setup()
    denied.fail(1); vi.advanceTimersByTime(120_000)
    expect(denied.callbacks).toHaveLength(1)
    expect(denied.geo.clearWatch).toHaveBeenCalledWith(1)
    const hidden = setup()
    hidden.fail(2); hidden.stop(); vi.advanceTimersByTime(120_000)
    hidden.fix()
    expect(hidden.callbacks).toHaveLength(1)
    expect(hidden.success).not.toHaveBeenCalled()
  })
})
