import { expect, test } from '@playwright/test'
import { api, fixture, installSyntheticSession, installYandexMapsMock, operationId, type FixtureIdentity } from './support.js'

test('driving past a point refuses politely, unblocks the next point and survives an old-client reload', async ({ context, page }, testInfo) => {
  test.setTimeout(120_000)
  const identity = fixture<FixtureIdentity>('prepare')
  await installSyntheticSession(context, identity)
  await installYandexMapsMock(context)
  await page.setViewportSize({ width: 390, height: 844 })
  const errors: Error[] = []
  page.on('pageerror', (error) => errors.push(error))
  const { kabanda } = await api<{ kabanda: { id: string } }>(page, 'POST', '/api/kabandas', {
    name: `GPS отказ ${identity.runId.slice(0, 8)}`, avatar: '🚲',
  }, operationId('team'))
  fixture('attach-catalogue', kabanda.id)
  let { raid } = await api<{ raid: { id: string; version: number } }>(page, 'POST', `/api/kabandas/${kabanda.id}/raids`, {
    title: 'Проверка пропущенной точки', description: null, scheduledAt: null, pointCategory: 'attractions',
  }, operationId('raid'))
  for (const command of ['open-lobby', 'assign-navigator']) {
    raid = (await api<{ raid: typeof raid }>(page, 'POST', `/api/raids/${raid.id}/commands/${command}`, {
      expectedVersion: raid.version, ...(command === 'assign-navigator' ? { navigatorUserId: identity.userId } : {}),
    }, operationId(command))).raid
  }
  raid = (await api<{ raid: typeof raid }>(page, 'POST', `/api/raids/${raid.id}/participants/me/ready`, {
    expectedVersion: raid.version,
  }, operationId('ready'))).raid
  const measuredAt = new Date().toISOString()
  raid = (await api<{ raid: typeof raid }>(page, 'POST', `/api/raids/${raid.id}/readiness`, {
    expectedVersion: raid.version, appMode: 'browser', locationPermission: 'granted',
    coordinateMeasuredAt: measuredAt, accuracyM: 8, indexedDbWritable: true,
    storageAvailable: true, online: true, measuredAt,
  }, operationId('readiness'))).raid
  await api(page, 'PUT', `/api/raids/${raid.id}/presence/me`, { ...identity.point, capturedAt: measuredAt, accuracyMeters: 8 })
  raid = (await api<{ raid: typeof raid }>(page, 'POST', `/api/raids/${raid.id}/commands/start`, {
    expectedVersion: raid.version,
  }, operationId('start'))).raid
  const { points } = await api<{ points: { id: string; name: string; latitude: number; longitude: number; visitedByMe: boolean }[] }>(page, 'GET', `/api/raids/${raid.id}/map-points`)
  expect(points.length).toBeGreaterThan(1)
  const a = points.find((p) => p.name === 'Синтетическая точка E2E')!
  expect(a).toBeTruthy()
  const b = points.find((p) => Math.abs(p.latitude - a.latitude) > .005)!
  expect(b).toBeTruthy()
  const gps = { latitude: a.latitude, longitude: a.longitude, accuracy: 8 }
  // Chromium's fixed emulation stops emitting fresh timestamps when stationary.
  // Feed a live synthetic GPS stream, just as a phone does, for this scenario.
  const gpsTimer = setInterval(() => { void context.setGeolocation(gps).catch(() => undefined) }, 1_000)
  try {
  await context.setGeolocation(gps)
  await page.goto(`/app?raid=${raid.id}`)
  const sheet = page.getByRole('complementary', { name: 'Подтверждение точки' })
  await expect(sheet.getByRole('heading', { name: a.name, exact: true })).toBeVisible()
  // Change the *next fresh* GPS fix without changing the already opened sheet.
  // Only this isolated browser is affected; the API makes the real distance decision.
  await page.evaluate((next) => {
    const original = navigator.geolocation.watchPosition.bind(navigator.geolocation)
    navigator.geolocation.watchPosition = (success, failure, options) => {
      if (options?.timeout === 15_000) {
        navigator.geolocation.watchPosition = original
        queueMicrotask(() => success({
          coords: { ...next, accuracy: 8, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
          timestamp: Date.now(), toJSON: () => ({}),
        } as GeolocationPosition))
        return 999999
      }
      return original(success, failure, options)
    }
  }, { latitude: b.latitude, longitude: b.longitude })
  const refused = page.waitForResponse((r) => r.url().endsWith(`/api/raids/${raid.id}/check-ins`) && r.request().method() === 'POST')
  await sheet.getByRole('button', { name: 'Пометить точку', exact: true }).click()
  const receipt = await (await refused).json()
  expect(receipt.reason).toBe('too_far')
  expect(receipt.credits).toEqual([])
  await expect(page.getByRole('status').filter({ hasText: 'Вы отъехали слишком далеко' })).toBeVisible()
  await expect(sheet).not.toBeVisible()
  await expect(page.getByText('Нужно закончить отметку', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('too-far-notice.png') })
  Object.assign(gps, { latitude: b.latitude, longitude: b.longitude })
  await context.setGeolocation(gps)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(sheet.getByRole('heading', { name: b.name, exact: true })).toBeVisible()
  const accepted = page.waitForResponse((r) => r.url().endsWith(`/api/raids/${raid.id}/check-ins`) && r.request().method() === 'POST')
  await sheet.getByRole('button', { name: 'Пометить точку', exact: true }).click()
  expect((await (await accepted).json()).outcome).toBe('accepted')
  // Simulate the same refused receipt persisted by the old client, then reload.
  await page.evaluate(async (operationId) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('kabanda-offline')
      request.onsuccess = () => resolve(request.result)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('checkInOutbox', 'readwrite')
      const store = tx.objectStore('checkInOutbox')
      const read = store.get(operationId)
      read.onsuccess = () => store.put({ ...read.result, status: 'needs_action' })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, receipt.operationId)
  await page.reload()
  await expect(page.getByLabel('Активный рейд Проверка пропущенной точки')).toBeVisible()
  await expect(page.getByText('Завершите отметку', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Причина ручной проверки', { exact: true })).toHaveCount(0)
  Object.assign(gps, { latitude: a.latitude, longitude: a.longitude })
  await context.setGeolocation(gps)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(sheet.getByRole('heading', { name: a.name, exact: true })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Пометить точку', exact: true })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('point-after-reload.png') })
  const revisited = page.waitForResponse((r) => r.url().endsWith(`/api/raids/${raid.id}/check-ins`) && r.request().method() === 'POST')
  await sheet.getByRole('button', { name: 'Пометить точку', exact: true }).click()
  const success = await (await revisited).json()
  expect(success.outcome).toBe('accepted')
  expect(success.operationId).not.toBe(receipt.operationId)
  expect(errors).toEqual([])
  } finally { clearInterval(gpsTimer) }
})
