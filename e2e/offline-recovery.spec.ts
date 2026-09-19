import type { Page } from '@playwright/test'
import { expect, test } from './persistent-test.js'
import {
  api, fixture, installSyntheticSession, installYandexMapsMock, operationId,
  type FixtureIdentity, waitForServiceWorkerControl,
} from './support.js'
import { installOfflineGps } from './recorder-gps-probe.js'

type RaidCounts = {
  routeSamples: number; routeReceipts: number; checkInAttempts: number; pointCredits: number
  media: number; readyMedia: number; requiredRouteSequenceAccepted: boolean | null
}
type LocalCounts = { routeMaxSequence: number; routePending: number; checkInPending: number; mediaPending: number }

async function localCounts(page: Page, raidId: string): Promise<LocalCounts> {
  return page.evaluate(async wantedRaidId => {
    const request = indexedDB.open('kabanda-offline')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    try {
      const storeNames = ['routeOutbox', 'checkInOutbox', 'mediaDrafts'] as const
      const transaction = db.transaction([...storeNames], 'readonly')
      const getAll = <T>(storeName: typeof storeNames[number]) => new Promise<T[]>((resolve, reject) => {
        const read = transaction.objectStore(storeName).getAll()
        read.onsuccess = () => resolve(read.result as T[]); read.onerror = () => reject(read.error)
      })
      const [routes, checkIns, media] = await Promise.all([
        getAll<{ raidId: string; sequence: number; status: string }>('routeOutbox'),
        getAll<{ raidId: string; status: string }>('checkInOutbox'),
        getAll<{ raidId: string; status: string }>('mediaDrafts'),
      ])
      const forRaid = <T extends { raidId: string }>(rows: T[]) => rows.filter(row => row.raidId === wantedRaidId)
      const routeRows = forRaid(routes), open = (status: string) => !['accepted', 'rejected'].includes(status)
      return {
        routeMaxSequence: Math.max(0, ...routeRows.map(({ sequence }) => sequence)),
        routePending: routeRows.filter(({ status }) => open(status)).length,
        checkInPending: forRaid(checkIns).filter(({ status }) => open(status)).length,
        mediaPending: forRaid(media).filter(({ status }) => open(status)).length,
      }
    } finally { db.close() }
  }, raidId)
}

// Only the new capability read is synthetic. Every legacy write and receipt is
// executed by the real API, and the production service worker remains enabled.
test('legacy offline route, check-in and photo survive reload and replay once', async ({ context, page }) => {
  test.setTimeout(120_000)
  const identity = fixture<FixtureIdentity>('prepare')
  await installYandexMapsMock(context)
  await installSyntheticSession(context, identity)
  await installOfflineGps(context, identity.point)
  // page.route cannot consistently intercept service-worker-owned requests.
  // Simulate the one absent capability before it reaches the worker, including
  // after an offline reload. Do not mock the old API, persistence or its writes.
  await context.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (method.toUpperCase() === 'GET' && url.origin === location.origin && /^\/api\/raids\/[^/]+\/fast\/live$/.test(url.pathname)) {
        return Promise.resolve(new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Synthetic pre-field API version' } }), {
          status: 404, headers: { 'content-type': 'application/json' },
        }))
      }
      return originalFetch(input, init)
    }
  })

  const { kabanda } = await api<{ kabanda: { id: string } }>(page, 'POST', '/api/kabandas', {
    name: `Offline E2E ${identity.runId.slice(0, 8)}`, avatar: '🚲',
  }, operationId('create-kabanda'))
  fixture('attach-point', kabanda.id)
  let { raid } = await api<{ raid: { id: string; version: number } }>(page, 'POST', `/api/kabandas/${kabanda.id}/raids`,
    { title: 'Offline recovery raid', description: null, scheduledAt: null }, operationId('create-raid'))
  for (const command of ['open-lobby', 'assign-navigator'] as const) {
    raid = (await api<{ raid: typeof raid }>(page, 'POST', `/api/raids/${raid.id}/commands/${command}`,
      { expectedVersion: raid.version, ...(command === 'assign-navigator' ? { navigatorUserId: identity.userId } : {}) }, operationId(command))).raid
  }
  raid = (await api<{ raid: typeof raid }>(page, 'POST', `/api/raids/${raid.id}/participants/me/ready`,
    { expectedVersion: raid.version }, operationId('ready'))).raid
  const measuredAt = new Date().toISOString()
  raid = (await api<{ raid: typeof raid }>(page, 'POST', `/api/raids/${raid.id}/readiness`, {
    expectedVersion: raid.version, appMode: 'browser', locationPermission: 'granted', coordinateMeasuredAt: measuredAt,
    accuracyM: 8, indexedDbWritable: true, storageAvailable: true, online: true, measuredAt,
  }, operationId('readiness'))).raid
  await api(page, 'PUT', `/api/raids/${raid.id}/presence/me`, { ...identity.point, capturedAt: measuredAt, accuracyMeters: 8 })
  raid = (await api<{ raid: typeof raid }>(page, 'POST', `/api/raids/${raid.id}/commands/start`,
    { expectedVersion: raid.version }, operationId('start'))).raid

  await page.goto(`/app?raid=${raid.id}`)
  await waitForServiceWorkerControl(page)
  await expect(page.getByLabel(/Активный рейд Offline recovery raid/)).toBeVisible({ timeout: 30_000 })
  const confirmation = page.getByRole('complementary', { name: 'Подтверждение точки' })
  await expect(confirmation).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Синтетическая точка E2E' })).toBeVisible()
  await expect(confirmation.locator('.checkin-panel input[type="file"]')).toHaveCount(1)
  const serverBaseline = fixture<RaidCounts>('inspect-raid', raid.id)
  const localBaseline = await localCounts(page, raid.id)

  await context.setOffline(true)
  await expect.poll(async () => (await localCounts(page, raid.id)).routeMaxSequence,
    { timeout: 30_000 }).toBeGreaterThan(localBaseline.routeMaxSequence)
  const offlineRouteSequence = (await localCounts(page, raid.id)).routeMaxSequence
  await page.locator('.checkin-panel input[type="file"]').setInputFiles('apps/pwa/public/pwa-192x192.png')
  await expect(page.getByText(/Фото сохранено локально/)).toBeVisible()
  await page.getByRole('button', { name: 'Пометить точку', exact: true }).click()
  await expect(page.getByText(/Чекин сохранён на телефоне/)).toBeVisible()
  await expect(page.locator('.checkin-panel--map > .checkin-pending')).toHaveText('Локально: 2')
  await expect.poll(async () => {
    const counts = await localCounts(page, raid.id); return [counts.checkInPending, counts.mediaPending]
  }).toEqual([1, 1])

  await page.reload({ waitUntil: 'domcontentloaded' })
  const savedOffline = page.getByRole('button', { name: /Сохранено без сети/ })
  await expect(confirmation.or(savedOffline).first()).toBeVisible()
  if (!(await confirmation.isVisible())) await savedOffline.click()
  await expect(confirmation).toBeVisible()
  await expect(page.locator('.checkin-panel--map > .checkin-pending')).toHaveText('Локально: 2')
  await expect.poll(async () => {
    const counts = await localCounts(page, raid.id); return [counts.checkInPending, counts.mediaPending]
  }).toEqual([1, 1])
  await context.setOffline(false)
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(async () => {
    const counts = await localCounts(page, raid.id); return [counts.routePending, counts.checkInPending, counts.mediaPending]
  }, { timeout: 45_000 }).toEqual([0, 0, 0])
  await expect.poll(() => fixture<RaidCounts>('inspect-raid', raid.id, String(offlineRouteSequence)).requiredRouteSequenceAccepted,
    { timeout: 45_000 }).toBe(true)
  await expect.poll(async () => {
    const nearby = await api<{ points: Array<{ creditedByTeam: boolean }> }>(page, 'GET',
      `/api/raids/${raid.id}/check-ins/nearby?latitude=${identity.point.latitude}&longitude=${identity.point.longitude}`)
    return nearby.points[0]?.creditedByTeam ?? false
  }, { timeout: 45_000 }).toBe(true)
  await expect.poll(async () => (await api<{ media: unknown[] }>(page, 'GET', `/api/raids/${raid.id}/media`)).media.length,
    { timeout: 45_000 }).toBe(1)
  await page.getByRole('button', { name: 'Действия рейда' }).click()
  await page.getByRole('button', { name: 'Поставить на паузу' }).click()
  await expect(page.getByRole('region', { name: 'Рейд на паузе', exact: true })).toBeVisible()
  const acceptedBeforeReload = fixture<RaidCounts>('inspect-raid', raid.id, String(offlineRouteSequence))
  expect(acceptedBeforeReload.routeSamples).toBeGreaterThan(serverBaseline.routeSamples)
  expect(acceptedBeforeReload).toMatchObject({ checkInAttempts: 1, pointCredits: 1, media: 1, readyMedia: 1, requiredRouteSequenceAccepted: true })
  await page.reload()
  await expect.poll(() => fixture<RaidCounts>('inspect-raid', raid.id, String(offlineRouteSequence))).toEqual(acceptedBeforeReload)
})
