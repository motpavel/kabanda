import { test as base, expect, type BrowserContextOptions } from '@playwright/test'
import { captureDeviceTrace, createDeviceContext } from './persistent-context.js'

/** Only durable-photo suites opt in. Other browser tests keep the default
 * private contexts; no mocks are added for IndexedDB, decoding or uploads. */
export const test = base.extend<{ reducedMotion: BrowserContextOptions['reducedMotion'] }>({
  // Context options are not necessarily separately registered runner fixtures.
  // Declare this one explicitly so test.use() can supply it to the normal
  // device profile without failing collection before any test has run.
  reducedMotion: ['no-preference', { option: true }],
  context: async ({ browser, context, contextOptions, baseURL, viewport, deviceScaleFactor, isMobile, hasTouch, userAgent,
    permissions, geolocation, serviceWorkers, reducedMotion, locale, timezoneId, colorScheme, ignoreHTTPSErrors }, use, info) => {
    if (browser.browserType().name() !== 'webkit') { await use(context); return }
    const device = await createDeviceContext(browser, { ...contextOptions, baseURL, viewport, deviceScaleFactor, isMobile, hasTouch, userAgent,
      permissions, geolocation, serviceWorkers, reducedMotion, locale, timezoneId, colorScheme, ignoreHTTPSErrors })
    const finishTrace = await captureDeviceTrace(device, info, 'persistent-webkit-trace')
    try { await use(device) }
    finally { await finishTrace(); await device.close() }
  },
})
export { expect }
