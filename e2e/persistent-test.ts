import { test as base, expect, type BrowserContextOptions } from '@playwright/test'
import { createDeviceContext } from './persistent-context.js'

/** Only durable-photo suites opt in. Other browser tests keep the default
 * private contexts; no mocks are added for IndexedDB, decoding or uploads. */
export const test = base.extend<{ reducedMotion: BrowserContextOptions['reducedMotion'] }>({
  // Context options are not necessarily separately registered runner fixtures.
  // Declare this one explicitly so test.use() can supply it to the normal
  // device profile without failing collection before any test has run.
  reducedMotion: ['no-preference', { option: true }],
  context: async ({ browser, context, contextOptions, baseURL, viewport, deviceScaleFactor, isMobile, hasTouch, userAgent,
    permissions, geolocation, serviceWorkers, reducedMotion, locale, timezoneId, colorScheme, ignoreHTTPSErrors }, use) => {
    if (browser.browserType().name() !== 'webkit') { await use(context); return }
    const device = await createDeviceContext(browser, { ...contextOptions, baseURL, viewport, deviceScaleFactor, isMobile, hasTouch, userAgent,
      permissions, geolocation, serviceWorkers, reducedMotion, locale, timezoneId, colorScheme, ignoreHTTPSErrors })
    // Playwright Test already starts and retains traces for contexts created
    // during a test, including persistent ones. A second tracing.start() fails
    // before the page is used and prevents any decoder/storage assertions.
    try { await use(device) }
    finally { await device.close() }
  },
})
export { expect }
