import { expect, test, type Page } from '@playwright/test'

async function install(page: Page) {
  await page.goto('/')
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/worker.js')
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
  })
}
const path = '/_yandex_tiles/v1/14/10613/5046.png?scale=2&map=mobile'
const read = (page: Page, url = path) => page.evaluate(async url => {
  const response = await fetch(url)
  const body = await response.blob()
  let decoded = false
  if (response.ok) {
    const image = new Image(), objectUrl = URL.createObjectURL(body)
    image.src = objectUrl
    try { await image.decode(); decoded = image.naturalWidth > 0 } finally { URL.revokeObjectURL(objectUrl) }
  }
  return { status: response.status, cache: response.headers.get('X-Kabanda-Tile'), decoded, bytes: body.size }
}, url)

test('mobile browser persists a real decoded PNG across reload and serves it when the upstream is unavailable', async ({ page }) => {
  await install(page)
  expect(await read(page)).toMatchObject({ status: 200, cache: 'miss', decoded: true })
  await page.reload()
  expect(await read(page)).toMatchObject({ status: 200, cache: 'hit', decoded: true })
  await page.evaluate(() => new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => { channel.port1.close(); resolve(true) }
    navigator.serviceWorker.controller!.postMessage('FIXTURE_UPSTREAM_OFFLINE', [channel.port2])
  }))
  expect(await read(page)).toMatchObject({ status: 200, cache: 'hit', decoded: true })
  expect((await read(page, path.replace('/5046.', '/5047.'))).status).toBe(503)
})

test('Chromium serves saved fragments with browser networking disabled', async ({ page, context, browserName }) => {
  // Playwright WebKit offline emulation rejects page fetch before this worker
  // can answer. Upstream failure + persisted reads are tested above on both.
  test.skip(browserName !== 'chromium', 'Physical Safari airplane-mode verification remains required')
  await install(page)
  await read(page)
  await context.setOffline(true)
  expect(await read(page)).toMatchObject({ status: 200, cache: 'hit', decoded: true })
})

test('unavailable API notifies the affected map and never replaces a saved image', async ({ page }) => {
  await install(page)
  await read(page)
  await page.evaluate(() => {
    (window as any).tileFailures = []
    navigator.serviceWorker.addEventListener('message', event => (window as any).tileFailures.push(event.data))
  })
  expect((await read(page, path.replace('/10613/', '/1/'))).status).toBe(503)
  await expect.poll(() => page.evaluate(() => (window as any).tileFailures)).toContainEqual({ type: 'KABANDA_YANDEX_TILE_FAILURE', mapId: 'mobile' })
  expect(await read(page)).toMatchObject({ status: 200, cache: 'hit', decoded: true })
  expect((await read(page, '/_yandex_tiles/v1/21/0/0.png')).status).toBe(400)
})
