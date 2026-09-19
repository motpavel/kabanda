import { test as base, expect } from '@playwright/test'
import { captureDeviceTrace, createDeviceContext } from './persistent-context.js'

/** Only durable-photo suites opt in. Other browser tests keep the default
 * private contexts; no mocks are added for IndexedDB, decoding or uploads. */
export const test = base.extend({
  context: async ({ browser, context, baseURL, viewport, deviceScaleFactor, isMobile, hasTouch, userAgent,
    permissions, geolocation, serviceWorkers, reducedMotion, locale, timezoneId, colorScheme, ignoreHTTPSErrors }, use, info) => {
    if (browser.browserType().name() !== 'webkit') { await use(context); return }
    const device = await createDeviceContext(browser, { baseURL, viewport, deviceScaleFactor, isMobile, hasTouch, userAgent,
      permissions, geolocation, serviceWorkers, reducedMotion, locale, timezoneId, colorScheme, ignoreHTTPSErrors })
    const finishTrace = await captureDeviceTrace(device, info, 'persistent-webkit-trace')
    try { await use(device) }
    finally { await finishTrace(); await device.close() }
  },
})
export { expect }
