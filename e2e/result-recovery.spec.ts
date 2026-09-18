import { expect, test, type Page, type Route } from '@playwright/test'
import { installYandexMapsMock } from './support.js'
import type { RaidProjection } from '../apps/pwa/src/features/raids/types.js'
import type { RaidResult } from '../apps/pwa/src/features/results/types.js'

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
const identityId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const raidId = '33333333-3333-4333-8333-333333333333'
const metrics = { durationSeconds: 600, distanceMeters: 1500, uniquePoints: 2, photos: 0 }
const raid: RaidProjection = {
  id: raidId, kabandaId: teamId, title: 'Сохранённая поездка', state: 'completed', version: 4,
  scheduledAt: null, description: null, organizerUserId: identityId, navigatorUserId: identityId,
  navigatorReady: true, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  participants: [{ id: identityId, displayName: 'Участник', avatarUrl: null, state: 'active' }], allowedActions: [],
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null },
}
const result: RaidResult = { schemaVersion: 1,
  raid: { id: raidId, kabandaId: teamId, title: raid.title, startedAt: '2026-09-18T12:00:00Z', completedAt: '2026-09-18T12:10:00Z', partial: false },
  personal: metrics, team: metrics, participants: [{ userId: identityId, displayName: 'Участник', metrics }],
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII=', 'base64')
const fail = (route: Route, status = 503) => route.fulfill({ status, json: { error: { code: status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE', message: 'Synthetic test response' } } })
const stats = (page: Page) => page.locator('.raid-completion__stats dd')

async function mockApp(page: Page, resultResponse: (route: Route) => Promise<void>, shareResponse = (route: Route) => fail(route)) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (path.endsWith('/result')) return resultResponse(route)
    if (path.endsWith('/share-card')) return shareResponse(route)
    if (path.endsWith('/route/track')) return fail(route)
    const body = path === '/api/me' ? { user: { id: identityId, displayName: 'Участник', username: 'result', email: 'result@example.test', identityKind: 'verified', avatarUrl: null } }
      : path === '/api/kabandas' ? { kabandas: [{ id: teamId, name: 'Кабанда', role: 'member', avatar: '🐗', coverImage: null, memberCount: 1, pointsCollectionId: null }] }
      : path.endsWith('/raids/history/page') ? { schemaVersion: 2, scope: url.searchParams.get('scope') ?? 'all', raids: [], nextCursor: null }
      : path.endsWith('/raids') ? { raids: [] }
      : path.includes('templates') ? { templates: [], nextCursor: null }
      : path.endsWith('/progress') ? { progress: { personal: { ...metrics, completedRaids: 1 }, team: { ...metrics, completedRaids: 1 } } }
      : path.endsWith('/members') ? { members: [{ id: identityId, displayName: 'Участник', role: 'member', avatarUrl: null }] }
      : path.endsWith('/points') ? { points: [] }
      : path === `/api/raids/${raidId}` || path.endsWith('/live') ? { raid } : {}
    return route.fulfill({ json: body })
  })
}
async function resultCacheCounts(page: Page) {
  return page.evaluate(async ({ identityId, raidId }) => {
    async function rows(name: string, store: string): Promise<Array<{ key: string; identityId: string; raidId?: string }>> {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      try {
        return await new Promise((resolve, reject) => {
          const request = db.transaction(store).objectStore(store).getAll()
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
        })
      } finally { db.close() }
    }
    const shared = await rows('kabanda-raid-reads-v1', 'snapshots')
    const legacy = await rows('kabanda-offline', 'raidResults')
    return {
      shared: shared.filter(row => { const key = JSON.parse(row.key); return key[0] === identityId && key[1] === raidId && key[2] === 'result' }).length,
      legacy: legacy.filter(row => row.identityId === identityId && row.raidId === raidId).length,
    }
  }, { identityId, raidId })
}
async function seedLegacyResult(page: Page) {
  await page.evaluate(async ({ identityId, result }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kabanda-offline')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('raidResults', 'readwrite')
        transaction.objectStore('raidResults').put({ key: JSON.stringify([identityId, result.raid.id]), identityId,
          raidId: result.raid.id, kabandaId: result.raid.kabandaId, savedAt: result.raid.completedAt, result })
        transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error)
      })
    } finally { db.close() }
  }, { identityId, result })
}
async function recheckUntil(page: Page, observed: () => number) {
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    return observed()
  }, { intervals: [1100], timeout: 8000 }).toBeGreaterThan(0)
}

test('cached metrics survive a failed recheck with a working retry and stable completion layout', async ({ page, context }) => {
  await installYandexMapsMock(context)
  let unavailable = false
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await mockApp(page, route => unavailable ? fail(route) : route.fulfill({ json: { result } }))
  await page.goto(`/app?raid=${raidId}`)
  await expect(stats(page)).toHaveText(['00:10:00', '2', '1', '1,5'])
  await expect.poll(async () => (await resultCacheCounts(page)).shared).toBe(1)
  unavailable = true
  await page.reload()
  await expect(stats(page)).toHaveText(['00:10:00', '2', '1', '1,5'])
  const retry = page.getByRole('button', { name: 'Повторить загрузку итогов' })
  await expect(retry).toBeEnabled()
  await expect(page.locator('.result-shell')).toContainText('Не удалось обновить данные.')
  await expect(page.getByRole('link', { name: 'Запланировать следующий рейд' })).toHaveCount(0)
  await page.evaluate(() => { (window as any).savedResultNodes = [document.querySelector('.raid-completion'), document.querySelector('.result-route')] })
  unavailable = false
  await retry.click()
  await expect(retry).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Запланировать следующий рейд' })).toBeVisible()
  expect(await page.evaluate(() => (window as any).savedResultNodes[0] === document.querySelector('.raid-completion') && (window as any).savedResultNodes[1] === document.querySelector('.result-route'))).toBe(true)
  expect(errors).toEqual([])
})

test('denied results cannot return from either cache after document reload', async ({ page, context }) => {
  await installYandexMapsMock(context)
  let mode: 'ready' | 'denied' | 'outage' = 'ready', denials = 0
  page.on('response', response => { if (response.url().endsWith('/result') && response.status() === 403) denials++ })
  await mockApp(page, route => mode === 'ready' ? route.fulfill({ json: { result } }) : fail(route, mode === 'denied' ? 403 : 503))
  await page.goto(`/app?raid=${raidId}`)
  await expect(stats(page)).toHaveText(['00:10:00', '2', '1', '1,5'])
  await expect.poll(async () => (await resultCacheCounts(page)).shared).toBe(1)
  await seedLegacyResult(page)
  expect(await resultCacheCounts(page)).toEqual({ shared: 1, legacy: 1 })
  mode = 'denied'
  await recheckUntil(page, () => denials)
  await expect(page.locator('.result-shell')).toContainText('Результат недоступен для просмотра.')
  await expect(page.locator('.result-metrics')).toHaveCount(0)
  await expect.poll(() => resultCacheCounts(page)).toEqual({ shared: 0, legacy: 0 })
  mode = 'outage'
  await page.reload()
  await expect(page.getByRole('button', { name: 'Повторить загрузку итогов' })).toBeEnabled()
  await expect(stats(page)).toHaveText(['…', '…', '…', '…'])
  await expect(page.locator('.result-metrics, .result-participants, .result-share')).toHaveCount(0)
})

test('share image retries independently without reloading successful metrics', async ({ page, context }) => {
  await installYandexMapsMock(context)
  let resultRequests = 0, imageRequests = 0, imageReady = false
  await mockApp(page, route => { resultRequests++; return route.fulfill({ json: { result } }) }, route => {
    imageRequests++
    return imageReady ? route.fulfill({ contentType: 'image/png', body: png }) : fail(route)
  })
  await page.goto(`/app?raid=${raidId}`)
  await expect(stats(page)).toHaveText(['00:10:00', '2', '1', '1,5'])
  const retry = page.getByRole('button', { name: 'Повторить подготовку карточки' })
  await expect(retry).toBeVisible()
  const before = resultRequests
  imageReady = true
  await retry.click()
  const image = page.getByAltText('Карточка с итогами рейда')
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: 'Поделиться карточкой' })).toBeEnabled()
  expect(resultRequests).toBe(before)
  expect(imageRequests).toBe(2)
  await expect(stats(page)).toHaveText(['00:10:00', '2', '1', '1,5'])
})

test('an image requested before access denial cannot restore a private share card', async ({ page, context }) => {
  await installYandexMapsMock(context)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let denied = false, denials = 0, requested = false
  page.on('response', response => { if (response.url().endsWith('/result') && response.status() === 403) denials++ })
  await mockApp(page, route => denied ? fail(route, 403) : route.fulfill({ json: { result } }), async route => {
    requested = true; await gate
    await route.fulfill({ contentType: 'image/png', body: png })
  })
  try {
    await page.goto(`/app?raid=${raidId}`)
    await expect.poll(() => requested).toBe(true)
    denied = true
    await recheckUntil(page, () => denials)
    await expect(page.locator('.result-shell')).toContainText('Результат недоступен для просмотра.')
    const delivered = page.waitForResponse(response => response.url().endsWith('/share-card'))
    release()
    await (await delivered).finished()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
    await expect(page.locator('.result-share, .result-metrics, .raid-completion')).toHaveCount(0)
    await expect.poll(async () => (await resultCacheCounts(page)).shared).toBe(0)
  } finally { release() }
})
