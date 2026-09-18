import { expect, test, type Page, type Route } from '@playwright/test'
import { installYandexMapsMock } from './support.js'
import type { RaidProjection } from '../apps/pwa/src/features/raids/types.js'
import type { RaidResult } from '../apps/pwa/src/features/results/types.js'
import type { RaidTemplateSummary } from '../apps/pwa/src/features/raid-plans/types.js'

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
const userId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const raidId = '33333333-3333-4333-8333-333333333333'
const metrics = { durationSeconds: 600, distanceMeters: 1500, uniquePoints: 2, photos: 0 }
const raid: RaidProjection = {
  id: raidId, kabandaId: teamId, title: 'Поездка на набережную', state: 'active', version: 3,
  scheduledAt: null, description: null, organizerUserId: userId, navigatorUserId: userId,
  navigatorReady: true, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  participants: [{ id: userId, displayName: 'Павел', avatarUrl: null, state: 'active' }], allowedActions: [],
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null },
}
const result: RaidResult = { schemaVersion: 1, raid: { id: raidId, kabandaId: teamId, title: raid.title, startedAt: '2026-09-18T12:00:00Z', completedAt: '2026-09-18T12:10:00Z', partial: false }, team: metrics, personal: metrics, participants: [{ userId, displayName: 'Павел', metrics }] }
const templates: RaidTemplateSummary[] = Array.from({ length: 7 }, (_, index) => ({
  id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`, kabandaId: teamId, scope: 'kabanda',
  title: `Маршрут ${index + 1}`, version: 1, cover: { url: '/brand/kabanda-team-cover.jpg', sha256: 'a'.repeat(64), width: 1792, height: 896 }, pointCount: 2, estimate: { method: 'straight_segments', distanceMeters: 1500 },
  createdAt: new Date(Date.UTC(2026, 8, index + 1)).toISOString(), updatedAt: new Date(Date.UTC(2026, 8, index + 1)).toISOString(),
}))
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

async function mockApp(page: Page, options: { state?: RaidProjection['state']; resultResponse?: (route: Route) => Promise<void> } = {}) {
  const projection = { ...raid, state: options.state ?? 'active' }
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (path.endsWith('/result') && options.resultResponse) return options.resultResponse(route)
    if (path.endsWith('/share-card') || path.endsWith('/route/track')) return route.fulfill({ status: 503, json: { error: { code: 'SYNTHETIC_UNAVAILABLE', message: 'Not part of this scenario' } } })
    const body = path === '/api/me' ? { user: { id: userId, displayName: 'Павел', username: 'pavel', email: 'pavel@example.test', identityKind: 'verified', avatarUrl: null } }
      : path === '/api/kabandas' ? { kabandas: [{ id: teamId, name: 'Вечерняя Кабанда', role: 'member', avatar: '🐗', coverImage: null, memberCount: 1, pointsCollectionId: null }] }
      : path.endsWith('/raids/history/page') ? { schemaVersion: 2, scope: url.searchParams.get('scope') ?? 'all', raids: [], nextCursor: null }
      : path.endsWith('/raids') ? { raids: projection.state === 'completed' ? [] : [projection] }
      : path.includes('templates') ? { templates, nextCursor: null }
      : path.endsWith('/progress') ? { progress: { personal: { ...metrics, completedRaids: 1 }, team: { ...metrics, completedRaids: 1 } } }
      : path.endsWith('/members') ? { members: [{ id: userId, displayName: 'Павел', role: 'member', avatarUrl: null }] }
      : path.endsWith('/points') ? { points: [] }
      : path.endsWith('/result') ? { result }
      : path === `/api/raids/${raidId}` || path.endsWith('/live') ? { raid: projection } : {}
    await route.fulfill({ json: body })
  })
}

for (const width of [320, 390, 1024]) test(`current ride leads the home page once at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  await mockApp(page)
  await page.goto(`/app?kabanda=${teamId}`)
  const current = page.locator('.kb-home .raid-home-current')
  await expect(current).toHaveCount(1)
  await expect(current).toContainText(raid.title)
  const rideBox = await current.boundingBox()
  const heroBox = await page.locator('.kb-home-hero').boundingBox()
  expect(rideBox).not.toBeNull(); expect(heroBox).not.toBeNull()
  expect(rideBox!.y).toBeLessThan(heroBox!.y)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
})

test('route catalog expands without losing history or exposing duplicate route cards', async ({ page }) => {
  await mockApp(page, { state: 'completed' })
  await page.goto(`/app?kabanda=${teamId}&tab=raids`)
  const cards = page.getByTestId('production-route-catalog').locator('.prd-template-card')
  await expect(cards).toHaveCount(4)
  await expect(cards.first()).toContainText('Маршрут 7')
  await page.getByRole('button', { name: 'Показать все маршруты (7)' }).click()
  await expect(cards).toHaveCount(7)
  await expect(page.getByTestId('production-raid-history')).toBeVisible()
  await page.getByRole('button', { name: 'Свернуть каталог' }).click()
  await expect(cards).toHaveCount(4)
  await page.getByRole('link', { name: 'Главная', exact: true }).click()
  await page.getByRole('link', { name: 'Рейды', exact: true }).click()
  await expect(cards).toHaveCount(4)
})

test('confirmed completion keeps the same hero and map while result metrics arrive', async ({ page, context }) => {
  await installYandexMapsMock(context)
  const gate = deferred()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await mockApp(page, { state: 'completed', resultResponse: async route => { await gate.promise; await route.fulfill({ json: { result } }) } })
  try {
    await page.goto(`/app?raid=${raidId}`)
    await expect(page.locator('.raid-completion__stats dd')).toHaveText(['…', '…', '…', '…'])
    await expect(page.getByRole('region', { name: 'Маршрут и посещения рейда' })).toBeVisible()
    await page.evaluate(() => { (window as any).resultNodes = [document.querySelector('.raid-completion'), document.querySelector('.result-route')] })
    gate.resolve()
    await expect(page.locator('.raid-completion__stats dd')).toHaveText(['00:10:00', '2', '1', '1,5'])
    expect(await page.evaluate(() => (window as any).resultNodes[0] === document.querySelector('.raid-completion') && (window as any).resultNodes[1] === document.querySelector('.result-route'))).toBe(true)
    await expect(page.getByRole('link', { name: 'Запланировать следующий рейд' })).toBeVisible()
    expect(errors).toEqual([])
  } finally { gate.resolve() }
})

test('failed result load can be retried without replacing the completion layout', async ({ page, context }) => {
  await installYandexMapsMock(context)
  let unavailable = true
  await mockApp(page, { state: 'completed', resultResponse: route => unavailable
    ? route.fulfill({ status: 503, json: { error: { code: 'SYNTHETIC_UNAVAILABLE', message: 'Try again' } } })
    : route.fulfill({ json: { result } }) })
  await page.goto(`/app?raid=${raidId}`)
  const retry = page.getByRole('button', { name: 'Повторить загрузку итогов' })
  await expect(retry).toBeEnabled()
  await page.evaluate(() => { (window as any).completionBeforeRetry = document.querySelector('.raid-completion') })
  unavailable = false
  await retry.click()
  await expect(page.locator('.raid-completion__stats dd')).toHaveText(['00:10:00', '2', '1', '1,5'])
  expect(await page.evaluate(() => (window as any).completionBeforeRetry === document.querySelector('.raid-completion'))).toBe(true)
  await expect(retry).toHaveCount(0)
})
