import { expect, test } from '@playwright/test'

// Run against a built PWA, not Vite's dev worker. No manual registration or
// reload: installation must attach to the first page through the app itself.
test('first mobile launch becomes controlled without a reload', async ({ page }) => {
  let navigations = 0
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++ })
  await page.goto('/app')
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 30_000 }).toBe(true)
  expect(navigations).toBe(1)
  const status = await page.evaluate(() => new Promise<{ version: number; enabled: boolean } | null>(resolve => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => { channel.port1.close(); resolve(null) }, 5000)
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data) }
    navigator.serviceWorker.controller!.postMessage({ type: 'KABANDA_YANDEX_TILES_STATUS' }, [channel.port2])
  }))
  expect(status).toMatchObject({ version: 1, enabled: true })
})
