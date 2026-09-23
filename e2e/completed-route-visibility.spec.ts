import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { installYandexMapsMock } from './support.js'
import type { PointVisitHistory } from '../packages/contracts/src/index.js'
import type { RaidMapPoint, RaidProjection, RouteTrackProjection } from '../apps/pwa/src/features/raids/types.js'

const userId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const raidId = '33333333-3333-4333-8333-333333333333'
const navigatorId = '44444444-4444-4444-8444-444444444444'
const at = '2026-09-20T12:00:00Z'
const base: RaidProjection = {
  id: raidId, kabandaId: teamId, title: 'Только наш маршрут', state: 'completed', version: 3,
  scheduledAt: null, description: null, organizerUserId: navigatorId, navigatorUserId: navigatorId,
  navigatorReady: true, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  participants: [userId, navigatorId].map(id => ({ id, displayName: 'Участник', avatarUrl: null, state: 'active' })),
  allowedActions: [], routeStatus: { status: 'stopped', lastSampleAt: at, lastReceivedAt: at, acceptedSampleCount: 3, missingSequenceCount: 0 },
}
const track: RouteTrackProjection = {
  segments: [[
    { latitude: 56.86, longitude: 53.21, capturedAt: at },
    { latitude: 56.864, longitude: 53.214, capturedAt: '2026-09-20T12:01:00Z' },
    { latitude: 56.868, longitude: 53.218, capturedAt: '2026-09-20T12:02:00Z' },
  ]], pointCount: 3, truncated: false, updatedAt: at, serverAt: at,
}
const points: RaidMapPoint[] = [
  ['Личная и командная', true, true, 56.861, 53.211],
  ['Только команда', false, true, 56.862, 53.212],
  ['Личная отметка', true, false, 56.863, 53.213],
  ['Не посетили вдали', false, false, 10, -100],
  ['Проехали без отметки', false, false, 56.864, 53.214],
].map(([name, visitedByMe, visitedByTeam, latitude, longitude], index) => ({
  id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
  sourcePointId: `66666666-6666-4666-8666-${String(index + 1).padStart(12, '0')}`,
  name: String(name), visitedByMe: Boolean(visitedByMe), visitedByTeam: Boolean(visitedByTeam),
  latitude: Number(latitude), longitude: Number(longitude), position: index, lastVisitedAt: at,
}))
const metrics = { durationSeconds: 120, distanceMeters: 1000, uniquePoints: 3, photos: 0 }
const history: PointVisitHistory = {
  visitors: [{ userId: navigatorId, displayName: 'Навигатор', count: 1 }],
  personalCount: 0, nextOffset: null,
  entries: [{ id: '77777777-7777-4777-8777-777777777777', raidId, title: base.title, state: 'completed',
    visitedAt: at, mine: false, personalVisits: 0,
    visits: [{ id: '88888888-8888-4888-8888-888888888888', userId: navigatorId,
      displayName: 'Навигатор', visitedAt: at, source: 'raid' }],
    participants: [{ userId: navigatorId, displayName: 'Навигатор' }] }],
}
type Camera = { center: number[]; zoom: number }

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' })

async function prepare(page: Page, options: { active?: boolean; emptyVisits?: boolean; delayedTrack?: boolean } = {}) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await installYandexMapsMock(page.context())
  // Record actual camera calls at the provider boundary. Either order of the
  // context/page init scripts is supported; no production state is replaced.
  await page.addInitScript(() => {
    const scope = window as unknown as { ymaps?: any; __overviewCameras: Camera[] }
    scope.__overviewCameras = []
    const instrument = (runtime: any) => {
      if (!runtime) return runtime
      const previous = runtime.Map.prototype.setCenter
      runtime.Map.prototype.setCenter = function(center: number[], zoom?: number) {
        previous.call(this, center, zoom)
        scope.__overviewCameras.push({ center: [...this.getCenter()], zoom: this.getZoom() })
      }
      return runtime
    }
    let value = instrument(scope.ymaps)
    Object.defineProperty(window, 'ymaps', { configurable: true, get: () => value,
      set: runtime => { value = instrument(runtime) } })
  })
  const raid = options.active ? { ...base, state: 'active' as const } : base
  const rows = options.emptyVisits ? points.map(point => ({ ...point, visitedByMe: false, visitedByTeam: false })) : points
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let requestedTrack = false
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (path.endsWith('/route/track')) {
      requestedTrack = true
      if (options.delayedTrack) await gate
      return route.fulfill({ json: { track } })
    }
    if (path.endsWith('/share-card') || path.endsWith('/content')) return route.fulfill({ contentType: 'image/png', body: readFileSync('apps/pwa/public/pwa-192x192.png') })
    const body = path === '/api/me' ? { user: { id: userId, displayName: 'Участник', username: 'completed-qa', email: 'qa@example.test', identityKind: 'verified', avatarUrl: null } }
      : path === '/api/kabandas' ? { kabandas: [{ id: teamId, name: 'Проверка итогов', role: 'member', avatar: '🐗', coverImage: null, memberCount: 2, pointsCollectionId: null }] }
      : path.endsWith('/result') ? { result: { schemaVersion: 1, raid: { id: raidId, kabandaId: teamId, title: raid.title,
          startedAt: at, completedAt: '2026-09-20T12:02:00Z', partial: false }, team: metrics, personal: metrics,
          participants: [{ userId, displayName: 'Участник', metrics }] } }
      : path.endsWith('/live') || path === `/api/raids/${raidId}` ? { raid, points: rows,
          teamVisits: !options.delayedTrack, fieldVisible: true, ...(options.delayedTrack ? {} : { track }) }
      : path.startsWith(`/api/kabandas/${teamId}/points/`) && path.endsWith('/history') ? history
      : path.endsWith('/materials') ? { materials: [{ id: 'photo', pointSnapshotId: path.split('/')[5], kind: 'photo', body: 'Фото с точки', authorName: 'Павел', authorUserId: navigatorId, ready: true, width: 192, height: 192, createdAt: at }, { id: 'comment', pointSnapshotId: path.split('/')[5], kind: 'comment', body: 'С кабаном Максом посетили', authorName: 'Павел', authorUserId: navigatorId, ready: true, width: null, height: null, createdAt: at }], nextCursor: null,
          canWrite: rows.find(point => point.id === path.split('/')[5])?.visitedByMe === true }
      : path.endsWith('/map-points') ? { points: rows }
      : path.endsWith('/media') ? { media: [{ id: 'photo', state: 'ready', contentType: 'image/jpeg', sizeBytes: 100, width: 192, height: 192, caption: 'Фото с точки', purpose: 'gallery', createdAt: at, uploaderUserId: navigatorId }], nextCursor: null }
      : path.endsWith('/check-ins/nearby') ? { policy: { version: 'v1', radiusMeters: 50, maxAgeSeconds: 60, maxAccuracyMeters: 50 }, points: [] }
      : path.endsWith('/presence/me') ? { radiusMeters: 50, maxAgeSeconds: 30, allReady: false, participants: [], serverAt: at }
      : path.endsWith('/raids/history/page') ? { schemaVersion: 2, scope: url.searchParams.get('scope') ?? 'all', raids: [], nextCursor: null }
      : path.endsWith('/raids') ? { raids: options.active ? [raid] : [] }
      : path.includes('templates') ? { templates: [], nextCursor: null }
      : path.endsWith('/members') ? { members: raid.participants.map(person => ({ ...person, role: 'member' })) }
      : path.endsWith('/progress') ? { progress: { personal: { ...metrics, completedRaids: 1 }, team: { ...metrics, completedRaids: 1 } } }
      : {}
    return route.fulfill({ json: body })
  })
  await page.goto(`/app?raid=${raidId}`)
  return { release, requestedTrack: () => requestedTrack, errors }
}
const cameras = (page: Page) => page.evaluate(() => (window as unknown as { __overviewCameras: Camera[] }).__overviewCameras)

async function expectRouteOverview(page: Page) {
  await expect.poll(async () => (await cameras(page)).at(-1)?.center[0]).toBeCloseTo(56.864, 4)
  await expect.poll(async () => (await cameras(page)).at(-1)?.center[1]).toBeCloseTo(53.214, 4)
  expect((await cameras(page)).at(-1)!.zoom).toBeGreaterThanOrEqual(13)
}

test('completed map and list keep only green visits, including team-only, with compact route bounds', async ({ page }, info) => {
  const control = await prepare(page)
  const map = page.locator('.result-route__map')
  await expect(map.locator('.raid-live-point')).toHaveCount(3)
  await expect(map.locator('.raid-live-point--visited')).toHaveCount(3)
  await expect(map.getByRole('button', { name: /Не посетили|Проехали без отметки/ })).toHaveCount(0)
  await expect(page.locator('.result-route__points li')).toHaveCount(3)
  await expectRouteOverview(page)
  await map.getByRole('button', { name: /^Только команда\./ }).click()
  const detail = page.locator('.result-route__history')
  await expect(detail).toContainText('Посетили')
  await expect(detail.getByRole('region', { name: 'Комментарии точки', exact: true })).toBeVisible()
  await expect(detail.locator('details.point-materials__history')).toHaveCount(0)
  await expect(detail.locator('a')).toHaveCount(0)
  // Team-only remains a visible green stop, but no longer permits contributing.
  await expect(detail.getByRole('button', { name: 'Комментарий', exact: true })).toHaveCount(0)
  await expect(detail.locator('input[type=file]')).toHaveCount(0)
  await expect(detail).toContainText('Фото и комментарии можно добавить после вашей подтверждённой отметки')
  await expect(detail.locator('.point-materials__item p')).toHaveText('Комментарий: С кабаном Максом посетили')
  await expect(page.getByText('Запланировать следующий рейд', { exact: true })).toHaveCount(0)
  await expect(page.getByText('К завершённым рейдам', { exact: true })).toHaveCount(0)
  await expect(page.locator('.result-people__table')).toContainText('Участник')
  await expect(page.locator('.result-route__point[aria-expanded="true"]')).toContainText('2Только команда')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(detail.getByRole('button', { name: 'Открыть фото на весь экран' })).toBeVisible()
  await detail.getByRole('button', { name: 'Открыть фото на весь экран' }).click()
  await expect(page.getByRole('dialog', { name: 'Просмотр фото' })).toBeVisible()
  await page.getByRole('button', { name: 'Закрыть фото' }).click()
  await expect(page.locator('.result-gallery__grid img')).toHaveCount(1)
  await page.getByRole('region', { name: 'Фотографии завершённого рейда' }).getByRole('button', { name: 'Открыть фото на весь экран' }).click()
  await expect(page.getByRole('dialog', { name: 'Просмотр фото' })).toBeVisible()
  await page.getByRole('button', { name: 'Закрыть фото' }).click()
  await expect(page.getByRole('dialog', { name: 'Просмотр фото' })).toHaveCount(0)
  // A different personally visited stop keeps its composer and photo action.
  await page.locator('.result-route__points').getByRole('button', { name: /1 Личная и командная/ }).click()
  await expect(detail.getByRole('button', { name: 'Комментарий', exact: true })).toBeVisible()
  await expect(detail.locator('input[type=file]')).toBeEnabled()
  await detail.getByRole('button', { name: 'Комментарий', exact: true }).click()
  await expect(detail.getByRole('textbox', { name: 'Комментарий', exact: true })).toBeFocused()
  await expect(page.locator('.result-shell > :last-child').getByRole('button', { name: 'Поделиться карточкой' })).toBeVisible()
  await page.setViewportSize({ width: 320, height: 760 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(control.errors).toEqual([])
  await page.screenshot({ path: info.outputPath('completed-visited-only.png'), fullPage: true })
})

test('no visits retains the recorded line, start and finish without falling back to red points', async ({ page }) => {
  await prepare(page, { emptyVisits: true })
  const map = page.locator('.result-route__map')
  await expect(map.locator('[data-yandex-polyline="true"][data-stroke-color="#17191b"]')).toHaveCount(1)
  await expect(map.getByRole('img', { name: 'Старт', exact: true })).toBeVisible()
  await expect(map.getByRole('img', { name: 'Финиш', exact: true })).toBeVisible()
  await expect(map.locator('.raid-live-point')).toHaveCount(0)
  await expect(page.locator('.result-route__points li')).toHaveCount(0)
  await expectRouteOverview(page)
})

test('late route geometry sets the completed overview instead of freezing the earlier catalogue bounds', async ({ page }) => {
  const control = await prepare(page, { delayedTrack: true })
  try {
    await expect.poll(control.requestedTrack).toBe(true)
    await expect(page.locator('.result-route__map .raid-live-point')).toHaveCount(3)
    expect((await cameras(page)).every(camera => camera.zoom === 12)).toBe(true)
    control.release()
    await expectRouteOverview(page)
  } finally { control.release() }
})

test('active raid still renders both visited and unvisited points', async ({ page }) => {
  await prepare(page, { active: true })
  const map = page.locator('.raid-active-map .route-live-map')
  await expect(map.locator('.raid-live-point')).toHaveCount(5)
  await expect(map.locator('.raid-live-point--visited')).toHaveCount(3)
  await expect(map.getByRole('button', { name: /^Не посетили вдали\./ })).toHaveCount(1)
})
