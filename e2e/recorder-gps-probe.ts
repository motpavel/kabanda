import type { BrowserContext, Page } from '@playwright/test'

/** Synthetic fixes for the recorder's five-second polling loop. Other GPS
 * calls retain the browser provider, including permission/refusal scenarios. */
export async function installRecorderGpsProbe(
  page: Page,
  point: { latitude: number; longitude: number },
  movement: 'jitter' | 'ride' = 'jitter',
) {
  await page.evaluate(({ origin, movement }) => {
    const geo = navigator.geolocation
    const original = geo.getCurrentPosition.bind(geo)
    let nextFailure: number | null = null
    let requests = 0
    Object.assign(window, {
      qaGpsFailure: (code: number) => { nextFailure = code },
      qaGpsRequests: () => requests,
    })
    geo.getCurrentPosition = (success, failure, options) => {
      if (options?.timeout !== 15_000) return original(success, failure, options)
      requests += 1
      const code = nextFailure
      nextFailure = null
      queueMicrotask(() => {
        if (code !== null) {
          failure?.({ code, message: 'Synthetic GPS failure', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 })
          return
        }
        // A route-line assertion must use actual movement, not sub-metre noise
        // that the new stationary display is specifically meant to suppress.
        // The triangular ride stays within 27m of the point and turns back.
        const phase = requests % 12
        const offset = movement === 'ride' ? Math.min(phase, 12 - phase) * .00004 : (requests % 20) * .000005
        success({
          coords: {
            latitude: origin.latitude + offset,
            longitude: origin.longitude + (movement === 'ride' ? 0 : offset),
            accuracy: 8, altitude: null, altitudeAccuracy: null,
            heading: movement === 'ride' ? (phase < 6 ? 0 : 180) : null,
            speed: movement === 'ride' ? .9 : null,
            toJSON: () => ({}),
          },
          timestamp: Date.now(), toJSON: () => ({}),
        })
      })
    }
  }, { origin: point, movement })
}

/** A real phone can measure GPS without an Internet connection. Chromium's
 * mock provider can instead produce POSITION_UNAVAILABLE after setOffline.
 * This fixture models fresh stationary measurements, not cached timestamps;
 * it survives reload and does not mock the recorder, IndexedDB or transport. */
export async function installOfflineGps(
  context: BrowserContext,
  point: { latitude: number; longitude: number },
) {
  await context.addInitScript(origin => {
    let next = 0
    const watches = new Map<number, ReturnType<typeof setInterval>>()
    const position = (): GeolocationPosition => ({
      coords: { latitude: origin.latitude, longitude: origin.longitude, accuracy: 8,
        altitude: null, altitudeAccuracy: null, speed: 0, heading: null, toJSON: () => ({}) },
      timestamp: Date.now(), toJSON: () => ({}),
    })
    Object.defineProperty(navigator.geolocation, 'getCurrentPosition', { configurable: true,
      value: (success: PositionCallback) => queueMicrotask(() => success(position())) })
    Object.defineProperty(navigator.geolocation, 'watchPosition', { configurable: true,
      value: (success: PositionCallback) => {
        const id = ++next
        queueMicrotask(() => { if (watches.has(id)) success(position()) })
        watches.set(id, setInterval(() => success(position()), 1000))
        return id
      } })
    Object.defineProperty(navigator.geolocation, 'clearWatch', { configurable: true,
      value: (id: number) => { clearInterval(watches.get(id)); watches.delete(id) } })
  }, point)
}
