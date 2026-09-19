import { expect, test, type Page } from '@playwright/test'
import { installYandexMapsMock } from './support.js'

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
const userId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const collectionId = '33333333-3333-4333-8333-333333333333'
const otherTeam = '55555555-5555-4555-8555-555555555555'
const user = { id: userId, email: 'continuity@example.test', username: 'continuity', displayName: 'Тестовый участник', avatarUrl: null, identityKind: 'verified' }
const team = { id: teamId, name: 'Проверка плавности', avatar: '🐗', coverImage: null, role: 'member', memberCount: 1, pointsCollectionId: collectionId }
const metrics = { durationSeconds: 1200, distanceMeters: 3000, uniquePoints: 1, photos: 1, completedRaids: 12 }
const history = Array.from({ length: 12 }, (_, index) => ({
  raidId: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`,
  title: `Поездка ${index + 1}`, completedAt: new Date(Date.UTC(2026, 8, 17, 12 - index)).toISOString(),
  partial: false, participated: true, team: metrics, personal: metrics,
}))
const point = { id: '66666666-6666-4666-8666-666666666666', stableId: 'test-point', name: 'Тестовая башня', latitude: 56.89, longitude: 53.25,
  verificationStatus: 'field_verified', visitedByMe: true, visitedByTeam: true, visitedByMeCount: 1, visitedByTeamCount: 1 }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

async function mockScreens(page: Page, gates: { actionable?: Promise<void>; progress?: Promise<void>; points?: Promise<void> } = {}) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (path.endsWith('/raids') && url.searchParams.get('scope') === 'actionable') {
      await gates.actionable
      return route.fulfill({ json: { raids: [] } })
    }
    if (path.endsWith('/points/progress')) return route.fulfill({ json: { category: 'stores', collectionId: null, complete: true, points: [] } })
    if (path.endsWith('/progress')) {
      await gates.progress
      return route.fulfill({ json: { progress: { team: metrics, personal: metrics } } })
    }
    if (path === '/api/points') {
      await gates.points
      return route.fulfill({ json: { points: [point] } })
    }
    if (/\/api\/kabandas\/[^/]+\/points\/[^/]+\/history$/.test(path)) {
      return route.fulfill({ json: { visitors: [{ userId, displayName: user.displayName, count: 1 }], personalCount: 1, entries: [], nextOffset: null } })
    }
    if (path.endsWith('/result')) return route.fulfill({ status: 503, json: { error: { code: 'TEST_RESULT_UNAVAILABLE', message: 'Synthetic' } } })
    if (/\/api\/raids\/[^/]+(?:\/(?:fast\/)?live)?$/.test(path)) {
      const raidId = path.split('/')[3]
      return route.fulfill({ json: { raid: {
        id: raidId, kabandaId: teamId, title: history.find(item => item.raidId === raidId)?.title ?? 'Поездка', state: 'completed', version: 10,
        scheduledAt: null, description: null, organizerUserId: userId, navigatorUserId: userId, navigatorReady: false,
        navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null, participants: [], allowedActions: [],
        routeStatus: { status: 'complete', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null },
      } } })
    }
    const body = path === '/api/me' ? { user }
      : path === '/api/kabandas' ? { kabandas: [team, { ...team, id: otherTeam, name: 'Другая Кабанда' }] }
      : path.endsWith('/raids/history/page') ? { schemaVersion: 2, scope: url.searchParams.get('scope') ?? 'all', raids: history, nextCursor: null }
      : path.endsWith('/raids/history') ? { raids: history, nextCursor: null }
      : path.endsWith('/members') ? { members: [{ id: userId, displayName: user.displayName, role: 'member', avatarUrl: null }] }
      : path.includes('templates') ? { templates: [], nextCursor: null } : {}
    return route.fulfill({ json: body })
  })
}
const y = (page: Page) => page.evaluate(() => window.scrollY)
async function expectPosition(page: Page, expected: number) {
  await expect.poll(async () => Math.abs(await y(page) - expected)).toBeLessThanOrEqual(4)
}

for (const width of [390, 1024]) test(`history/detail and tabs restore their own scroll at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await mockScreens(page)
  await page.goto(`/app?kabanda=${teamId}&tab=raids`)
  const card = page.getByRole('link', { name: /^Открыть историю рейда: Поездка 7\./ })
  await expect(card).toBeVisible()
  await card.evaluate(element => element.scrollIntoView({ block: 'center' }))
  await expect.poll(() => y(page)).toBeGreaterThan(200)
  const raidsY = await y(page)
  await card.click()
  await expect(page.getByRole('link', { name: 'Назад', exact: true })).toBeVisible()
  await expectPosition(page, 0)
  await page.getByRole('link', { name: 'Назад', exact: true }).click()
  await expect(page.getByTestId('production-raids-hub')).toBeVisible()
  await expectPosition(page, raidsY)
  await page.getByRole('link', { name: 'Главная', exact: true }).click()
  await expectPosition(page, 0)
  await page.evaluate(() => window.scrollTo({ top: 160, behavior: 'instant' }))
  const homeY = await y(page)
  await page.getByRole('link', { name: 'Рейды', exact: true }).click()
  await expectPosition(page, raidsY)
  await page.goBack()
  await expect(page.getByRole('link', { name: 'Главная', exact: true })).toHaveAttribute('aria-current', 'page')
  await expectPosition(page, homeY)
  await page.goForward()
  await expectPosition(page, raidsY)
  expect(errors).toEqual([])
})

test('create controls keep their geometry without a usable href during initial verification', async ({ page }) => {
  const gate = deferred()
  await mockScreens(page, { actionable: gate.promise })
  try {
    await page.goto(`/app?kabanda=${teamId}&tab=raids`)
    const action = page.getByTestId('production-new-raid')
    const template = page.getByTestId('production-new-template')
    await expect(action).toBeVisible()
    await expect(template).toBeVisible()
    await expect(action).toHaveAttribute('aria-disabled', 'true')
    await expect(action).not.toHaveAttribute('href')
    await expect(template).not.toHaveAttribute('href')
    const before = await action.boundingBox()
    await action.focus()
    await action.press('Enter')
    await expect(page).not.toHaveURL(/createRaid=/)
    gate.resolve()
    await expect(action).toHaveAttribute('href', `/app?createRaid=${teamId}`)
    const after = await action.boundingBox()
    expect(before).not.toBeNull(); expect(after).not.toBeNull()
    expect(Math.abs(before!.y - after!.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(before!.height - after!.height)).toBeLessThanOrEqual(1)
  } finally { gate.resolve() }
})

test('unknown team totals are placeholders rather than zero achievements', async ({ page }) => {
  const gate = deferred()
  await mockScreens(page, { progress: gate.promise, points: gate.promise })
  try {
    await page.goto(`/app?kabanda=${teamId}&tab=kabanda`)
    const totals = page.locator('.kb-team-metric strong')
    await expect(totals).toHaveText(['…', '…', '…'])
    gate.resolve()
    await expect(totals).toHaveText(['1', '1', '12'])
  } finally { gate.resolve() }
})

async function instrumentMap(page: Page) {
  await page.evaluate(() => {
    const win = window as any
    const Original = win.ymaps.Map
    const probe = { map: null as any, created: 0, destroyed: 0, callbacks: [] as Array<(p: unknown) => void> }
    win.continuityMap = probe
    win.ymaps.Map = class extends Original {
      constructor(...args: any[]) { super(...args); probe.map = this; probe.created++ }
      destroy() { probe.destroyed++; super.destroy() }
    }
    Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
      configurable: true, value: (success: (p: unknown) => void) => { probe.callbacks.push(success) },
    })
  })
}
const camera = (page: Page) => page.evaluate(() => {
  const map = (window as any).continuityMap.map
  return { center: map.getCenter(), zoom: map.getZoom() }
})
async function deliverPosition(page: Page, index: number) {
  await page.evaluate(i => (window as any).continuityMap.callbacks[i]({
    coords: { latitude: 56.85, longitude: 53.2, accuracy: 8 }, timestamp: Date.now(),
  }), index)
}

test('map retains camera, category and selection without leaving a hidden map or repeating auto-location', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await installYandexMapsMock(context)
  await mockScreens(page)
  await page.goto(`/app?kabanda=${teamId}`)
  await expect(page.getByRole('heading', { name: 'Соберёмся на прогулку?' })).toBeVisible()
  await instrumentMap(page)
  await page.getByRole('link', { name: 'Карта', exact: true }).click()
  const map = page.locator('[data-kabanda-map]')
  await expect(map).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).continuityMap.callbacks.length)).toBe(1)
  await map.dispatchEvent('pointerdown')
  await page.evaluate(() => (window as any).continuityMap.map.setCenter([56.9, 53.26], 16))
  await deliverPosition(page, 0)
  expect(await camera(page)).toEqual({ center: [56.9, 53.26], zoom: 16 })
  await page.getByRole('link', { name: 'Рейды', exact: true }).click()
  await expect(map).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).continuityMap.destroyed)).toBe(1)
  await page.getByRole('link', { name: 'Карта', exact: true }).click()
  await expect(map).toBeVisible()
  expect(await camera(page)).toEqual({ center: [56.9, 53.26], zoom: 16 })
  expect(await page.evaluate(() => (window as any).continuityMap.callbacks.length)).toBe(1)
  await page.getByRole('combobox', { name: 'Категория точек' }).selectOption('attractions')
  const marker = page.getByRole('button', { name: /^Тестовая башня\./ })
  await expect(marker).toBeVisible()
  await marker.focus(); await marker.press('Enter')
  await expect(marker).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('heading', { name: 'Тестовая башня', exact: true })).toBeVisible()
  await page.goBack()
  await expect(map).toHaveCount(0)
  await page.goForward()
  await expect(map).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Категория точек' })).toHaveValue('attractions')
  await expect(marker).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('heading', { name: 'Тестовая башня', exact: true })).toBeVisible()
  expect(await camera(page)).toEqual({ center: [56.9, 53.26], zoom: 16 })
  expect(errors).toEqual([])
})

test('late location from a destroyed map is ignored; the explicit locate button still works', async ({ page, context }) => {
  await installYandexMapsMock(context)
  await mockScreens(page)
  await page.goto(`/app?kabanda=${teamId}`)
  await expect(page.getByRole('heading', { name: 'Соберёмся на прогулку?' })).toBeVisible()
  await instrumentMap(page)
  await page.getByRole('link', { name: 'Карта', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).continuityMap.callbacks.length)).toBe(1)
  await page.evaluate(() => (window as any).continuityMap.map.setCenter([56.9, 53.26], 16))
  await page.getByRole('link', { name: 'Рейды', exact: true }).click()
  await page.getByRole('link', { name: 'Карта', exact: true }).click()
  await expect(page.locator('[data-kabanda-map]')).toBeVisible()
  await deliverPosition(page, 0)
  expect(await camera(page)).toEqual({ center: [56.9, 53.26], zoom: 16 })
  await expect(page.locator('.kb-yandex-user-location')).toHaveCount(0)
  await page.getByRole('button', { name: 'Показать моё местоположение', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).continuityMap.callbacks.length)).toBe(2)
  await deliverPosition(page, 1)
  expect(await camera(page)).toEqual({ center: [56.85, 53.2], zoom: 14 })
  await expect(page.locator('.kb-yandex-user-location')).toHaveCount(1)
  await page.evaluate(id => {
    window.history.pushState(null, '', `/app?kabanda=${id}&tab=map`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, otherTeam)
  await expect.poll(() => camera(page)).toEqual({ center: [56.8528, 53.2045], zoom: 12 })
})
