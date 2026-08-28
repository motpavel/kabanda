import { describe, expect, it, vi } from 'vitest'
import { resetGpsWatch, type WatchIdRef } from './gps-watch'

describe('resetGpsWatch', () => {
  it('clears a failed watch and allows a fresh retry', async () => {
    const watchIdRef: WatchIdRef = { current: null }
    const clearWatch = vi.fn()
    const releaseWakeLock = vi.fn(async () => undefined)
    let nextWatchId = 0

    const start = () => {
      if (watchIdRef.current !== null) return false
      nextWatchId += 1
      watchIdRef.current = nextWatchId
      return true
    }

    expect(start()).toBe(true)
    expect(watchIdRef.current).toBe(1)

    await resetGpsWatch({ clearWatch }, watchIdRef, releaseWakeLock)

    expect(clearWatch).toHaveBeenCalledOnce()
    expect(clearWatch).toHaveBeenCalledWith(1)
    expect(releaseWakeLock).toHaveBeenCalledOnce()
    expect(watchIdRef.current).toBeNull()
    expect(start()).toBe(true)
    expect(watchIdRef.current).toBe(2)
  })
})
