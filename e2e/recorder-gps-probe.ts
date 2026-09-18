import type { Page } from '@playwright/test'

/** Synthetic fixes for the recorder's current five-second getCurrentPosition
 * loop. Does not change production freshness checks, permissions or replay.
 * Other geolocation requests still use Chromium's normal synthetic provider. */
export async function installRecorderGpsProbe(page: Page, point: { latitude: number; longitude: number }) {
  await page.evaluate(origin => {
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
        // Vary the synthetic position within the test point's 50 m radius. Each
        // poll represents a new measurement rather than one indefinitely cached fix.
        const offset = (requests % 20) * .000005
        success({
          coords: {
            latitude: origin.latitude + offset, longitude: origin.longitude + offset,
            accuracy: 8, altitude: null, altitudeAccuracy: null, heading: null, speed: null,
            toJSON: () => ({}),
          },
          timestamp: Date.now(), toJSON: () => ({}),
        })
      })
    }
  }, point)
}
