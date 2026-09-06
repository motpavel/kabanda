import { afterEach, describe, expect, it, vi } from 'vitest'
import { eligibleManualVerifier, getOneShotCoordinate, sha256Hex, validateMediaFile } from './platform'

describe('fresh independent check-in GPS', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  function gps() {
    let success!: PositionCallback
    let failure!: PositionErrorCallback
    const clearWatch = vi.fn()
    const watchPosition = vi.fn((ok: PositionCallback, bad: PositionErrorCallback) => { success = ok; failure = bad; return 12 })
    vi.stubGlobal('navigator', { geolocation: { watchPosition, clearWatch } })
    return { clearWatch, sample: (age = 0) => success({ timestamp: Date.now() - age,
      coords: { latitude: 56.86, longitude: 53.21, accuracy: 8 } } as GeolocationPosition),
    error: (code: number) => failure({ code } as GeolocationPositionError) }
  }
  it('keeps waiting through transient failures and discards stale evidence', async () => {
    const mock = gps()
    const result = getOneShotCoordinate()
    mock.error(2)
    mock.error(3)
    mock.sample(60_000)
    expect(mock.clearWatch).not.toHaveBeenCalled()
    mock.sample()
    await expect(result).resolves.toMatchObject({ latitude: 56.86, longitude: 53.21, accuracyMeters: 8 })
    expect(mock.clearWatch).toHaveBeenCalledExactlyOnceWith(12)
  })
  it('rejects denied permission immediately and removes the subscription', async () => {
    const mock = gps()
    const result = getOneShotCoordinate()
    mock.error(1)
    await expect(result).rejects.toMatchObject({ code: 1 })
    expect(mock.clearWatch).toHaveBeenCalledExactlyOnceWith(12)
  })
  it('has a hard deadline even when the provider never calls back', async () => {
    vi.useFakeTimers()
    const mock = gps()
    const result = getOneShotCoordinate(1000)
    const assertion = expect(result).rejects.toThrow('GPS_TIMEOUT')
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    expect(mock.clearWatch).toHaveBeenCalledExactlyOnceWith(12)
  })
})

describe('check-in media boundaries', () => {
  it('hashes source bytes with a stable sha256', async () => {
    expect(await sha256Hex(new Blob(['kabanda']))).toBe('0bd8bb4c0f1b1ae354477c15e4ea9c1cc2acd84cfba00023daa19b008a3e0bd9')
  })

  it('rejects unsupported and oversized media before persistence', () => {
    expect(validateMediaFile(new File(['x'], 'x.gif', { type: 'image/gif' }))).toMatch(/JPEG/)
    expect(validateMediaFile(new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'x.jpg', { type: 'image/jpeg' }))).toMatch(/8 МиБ/)
  })

  it('never permits self-verification or an inactive verifier', () => {
    expect(eligibleManualVerifier('a', 'a', ['a', 'b'])).toBe(false)
    expect(eligibleManualVerifier('a', 'c', ['a', 'b'])).toBe(false)
    expect(eligibleManualVerifier('a', 'b', ['a', 'b'])).toBe(true)
  })
})
