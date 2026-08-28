import { expect, test, type Page } from '@playwright/test'
import {
  api,
  fixture,
  installSyntheticSession,
  operationId,
  type FixtureIdentity,
  waitForServiceWorkerControl,
} from './support.js'

type RaidCounts = {
  routeSamples: number
  routeReceipts: number
  checkInAttempts: number
  pointCredits: number
  media: number
  readyMedia: number
  requiredRouteSequenceAccepted: boolean | null
}

type LocalCounts = {
  routeMaxSequence: number
  routePending: number
  checkInPending: number
  mediaPending: number
}

async function localCounts(page: Page, raidId: string): Promise<LocalCounts> {
  return page.evaluate(async (wantedRaidId) => {
    const request = indexedDB.open('kabanda-offline')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const storeNames = ['routeOutbox', 'checkInOutbox', 'mediaDrafts'] as const
      const transaction = db.transaction([...storeNames], 'readonly')
      const getAll = <T>(storeName: typeof storeNames[number]) => new Promise<T[]>((resolve, reject) => {
        const read = transaction.objectStore(storeName).getAll()
        read.onsuccess = () => resolve(read.result as T[])
        read.onerror = () => reject(read.error)
      })
      const [routes, checkIns, media] = await Promise.all([
        getAll<{ raidId: string; sequence: number; status: string }>('routeOutbox'),
        getAll<{ raidId: string; status: string }>('checkInOutbox'),
        getAll<{ raidId: string; status: string }>('mediaDrafts'),
      ])
      const forRaid = <T extends { raidId: string }>(rows: T[]) => rows.filter((row) => row.raidId === wantedRaidId)
      const routeRows = forRaid(routes)
      const open = (status: string) => !['accepted', 'rejected'].includes(status)
      return {
        routeMaxSequence: Math.max(0, ...routeRows.map(({ sequence }) => sequence)),
        routePending: routeRows.filter(({ status }) => open(status)).length,
        checkInPending: forRaid(checkIns).filter(({ status }) => open(status)).length,
        mediaPending: forRaid(media).filter(({ status }) => open(status)).length,
      }
    } finally {
      db.close()
    }
  }, raidId)
}

test('offline route, check-in and photo survive reload and replay once', async ({ context, page }) => {
  const identity = fixture<FixtureIdentity>('prepare')
  await installSyntheticSession(context, identity)

  const kabanda = await api<{ kabanda: { id: string } }>(page, 'POST', '/api/kabandas', {
    name: `Offline E2E ${identity.runId.slice(0, 8)}`,
    avatar: '🚲',
  }, operationId('create-kabanda'))
  fixture('attach-point', kabanda.kabanda.id)
  const created = await api<{ raid: { id: string; version: number } }>(
    page,
    'POST',
    `/api/kabandas/${kabanda.kabanda.id}/raids`,
    { title: 'Offline recovery raid', description: null, scheduledAt: null },
    operationId('create-raid'),
  )
  let raid = created.raid
  for (const command of ['open-lobby', 'assign-navigator'] as const) {
    const response = await api<{ raid: typeof raid }>(
      page,
      'POST',
      `/api/raids/${raid.id}/commands/${command}`,
      command === 'assign-navigator'
        ? { expectedVersion: raid.version, navigatorUserId: identity.userId }
        : { expectedVersion: raid.version },
      operationId(command),
    )
    raid = response.raid
  }
  raid = (await api<{ raid: typeof raid }>(
    page,
    'POST',
    `/api/raids/${raid.id}/participants/me/ready`,
    { expectedVersion: raid.version },
    operationId('ready'),
  )).raid
  const measuredAt = new Date().toISOString()
  raid = (await api<{ raid: typeof raid }>(
    page,
    'POST',
    `/api/raids/${raid.id}/readiness`,
    {
      expectedVersion: raid.version,
      appMode: 'browser',
      locationPermission: 'granted',
      coordinateMeasuredAt: measuredAt,
      accuracyM: 8,
      indexedDbWritable: true,
      storageAvailable: true,
      online: true,
      measuredAt,
    },
    operationId('readiness'),
  )).raid
  raid = (await api<{ raid: typeof raid }>(
    page,
    'POST',
    `/api/raids/${raid.id}/commands/start`,
    { expectedVersion: raid.version },
    operationId('start'),
  )).raid

  await page.goto(`/app?raid=${raid.id}`)
  await waitForServiceWorkerControl(page)
  await expect(page.getByText('fresh', { exact: true })).toBeVisible({ timeout: 30_000 })
  await context.setGeolocation({ latitude: 56.86005, longitude: 53.21005, accuracy: 8 })
  await page.getByRole('button', { name: 'Найти точку рядом' }).click()
  await expect(page.getByText('Синтетическая точка E2E')).toBeVisible()

  const serverBaseline = fixture<RaidCounts>('inspect-raid', raid.id)
  const localBaseline = await localCounts(page, raid.id)

  await context.setOffline(true)
  await context.setGeolocation({ latitude: 56.8601, longitude: 53.2101, accuracy: 8 })
  await expect.poll(async () => (await localCounts(page, raid.id)).routeMaxSequence, {
    timeout: 30_000,
  }).toBeGreaterThan(localBaseline.routeMaxSequence)
  const offlineRouteSequence = (await localCounts(page, raid.id)).routeMaxSequence
  await page.getByRole('button', { name: 'Отметиться у точки' }).click()
  await page.locator('input[type="file"]').setInputFiles('apps/pwa/public/pwa-192x192.png')
  await expect(page.getByText('Локально: 2', { exact: true })).toBeVisible()
  await expect(page.getByText(/Фото сохранено локально/)).toBeVisible()
  await expect.poll(async () => {
    const counts = await localCounts(page, raid.id)
    return [counts.checkInPending, counts.mediaPending]
  }).toEqual([1, 1])

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Локально: 2', { exact: true })).toBeVisible()
  await expect.poll(async () => {
    const counts = await localCounts(page, raid.id)
    return [counts.checkInPending, counts.mediaPending]
  }).toEqual([1, 1])
  await context.setOffline(false)

  await expect.poll(async () => {
    const counts = await localCounts(page, raid.id)
    return [counts.routePending, counts.checkInPending, counts.mediaPending]
  }, { timeout: 45_000 }).toEqual([0, 0, 0])
  await expect.poll(
    () => fixture<RaidCounts>('inspect-raid', raid.id, String(offlineRouteSequence))
      .requiredRouteSequenceAccepted,
    { timeout: 45_000 },
  ).toBe(true)

  await expect.poll(async () => {
    const nearby = await api<{ points: Array<{ creditedByTeam: boolean }> }>(
      page,
      'GET',
      `/api/raids/${raid.id}/check-ins/nearby?latitude=${identity.point.latitude}&longitude=${identity.point.longitude}`,
    )
    return nearby.points[0]?.creditedByTeam ?? false
  }, { timeout: 45_000 }).toBe(true)
  await expect.poll(async () => {
    const gallery = await api<{ media: unknown[] }>(page, 'GET', `/api/raids/${raid.id}/media`)
    return gallery.media.length
  }, { timeout: 45_000 }).toBe(1)
  await page.getByRole('button', { name: 'Поставить на паузу' }).click()
  await expect(page.getByText('Пауза', { exact: true })).toBeVisible()

  const acceptedBeforeReload = fixture<RaidCounts>('inspect-raid', raid.id, String(offlineRouteSequence))
  expect(acceptedBeforeReload.routeSamples).toBeGreaterThan(serverBaseline.routeSamples)
  expect(acceptedBeforeReload).toMatchObject({
    checkInAttempts: 1,
    pointCredits: 1,
    media: 1,
    readyMedia: 1,
    requiredRouteSequenceAccepted: true,
  })

  await page.reload()
  await expect.poll(
    () => fixture<RaidCounts>('inspect-raid', raid.id, String(offlineRouteSequence)),
  ).toEqual(acceptedBeforeReload)
})
