import { expect, test } from '@playwright/test'
import { api, fixture, installSyntheticSession, installYandexMapsMock, operationId, type FixtureIdentity } from './support.js'

test('driving past a point refuses politely, unblocks the next point and survives an old-client reload', async ({ context, page }, testInfo) => {
  test.setTimeout(120_000)
  const identity = fixture<FixtureIdentity>('prepare')
  await installSyntheticSession(context, identity)
  await installYandexMapsMock(context)
  await page.setViewportSize({ width: 390, height: 844 })
  const errors: Error[] = []
  page.on('pageerror', error => errors.push(error))
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
  const a = points.find(point => point.name === 'Синтетическая точка E2E')!
  const b = points.find(point => Math.abs(point.latitude - a.latitude) > .005)!
  expect(a).toBeTruthy(); expect(b).toBeTruthy()
  const gps = { latitude: a.latitude, longitude: a.longitude, accuracy: 8 }
  const gpsTimer = setInterval(() => { void context.setGeolocation(gps).catch(() => undefined) }, 1000)
  const commandPath = `/api/raids/${raid.id}/check-ins/team`
  try {
    await context.setGeolocation(gps)
    await page.goto(`/app?raid=${raid.id}`)
    const sheet = page.getByRole('complementary', { name: 'Подтверждение точки' })
    await expect(sheet.getByRole('heading', { name: a.name, exact: true })).toBeVisible()
    // Change only the next independent confirmation measurement. The already
    // opened stop is retained, and the real API must reject the far coordinate.
    await page.evaluate(next => {
      const original = navigator.geolocation.watchPosition.bind(navigator.geolocation)
      navigator.geolocation.watchPosition = (success, failure, options) => {
        if (options?.maximumAge === 0 && options.timeout === 10_000) {
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
    const refused = page.waitForResponse(response => response.url().endsWith(commandPath) && response.request().method() === 'POST')
    await sheet.getByRole('button', { name: 'Пометить точку', exact: true }).click()
    const receipt = await (await refused).json()
    expect(receipt.reason).toBe('too_far')
    expect(receipt.credits).toEqual([])
    expect(receipt.claims).toEqual([])
    await expect(sheet.getByRole('status').filter({ hasText: 'Вы отъехали слишком далеко' })).toBeVisible()
    // Refusal is not success: keep the selected stop visible and allow a new
    // measurement rather than showing a green pin or creating a manual claim.
    await expect(sheet.getByRole('button', { name: 'Пометить точку', exact: true })).toBeEnabled()
    await expect(page.getByText('Нужно закончить отметку', { exact: true })).toHaveCount(0)
    expect((await api<{ points: typeof points }>(page, 'GET', `/api/raids/${raid.id}/map-points`)).points.find(point => point.id === a.id)?.visitedByMe).toBe(false)
    await page.screenshot({ path: testInfo.outputPath('too-far-notice.png') })
    Object.assign(gps, { latitude: b.latitude, longitude: b.longitude })
    await context.setGeolocation(gps)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(sheet.getByRole('heading', { name: b.name, exact: true })).toBeVisible({ timeout: 20_000 })
    const accepted = page.waitForResponse(response => response.url().endsWith(commandPath) && response.request().method() === 'POST')
    await sheet.getByRole('button', { name: 'Пометить точку', exact: true }).click()
    expect((await (await accepted).json()).outcome).toBe('accepted')

    // A v2 operation is never rewritten as v1. Create a genuine legacy refusal
    // with the old endpoint and persist exactly the row an installed v1 client
    // would have retained, then verify compatibility on the next reload.
    const legacyId = operationId('legacy-refused')
    const legacyInput = { pointSnapshotId: a.id, evidence: {
      latitude: b.latitude, longitude: b.longitude, accuracyMeters: 8, capturedAt: new Date().toISOString(),
    }, presentParticipantIds: [], organizerAttestation: false }
    const legacyReceipt = await api<{ operationId: string; reason: string }>(page, 'POST', `/api/raids/${raid.id}/check-ins`, legacyInput, legacyId)
    expect(legacyReceipt.reason).toBe('too_far')
    await page.evaluate(async input => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('kabanda-offline')
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('checkInOutbox', 'readwrite')
          tx.objectStore('checkInOutbox').add(input)
          tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
        })
      } finally { db.close() }
    }, { ...legacyInput, operationId: legacyId, identityId: identity.userId, kabandaId: kabanda.id,
      raidId: raid.id, status: 'needs_action', attempts: 1, claimUntil: null, nextAttemptAt: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastErrorCode: 'too_far', response: legacyReceipt })
    await page.reload()
    await expect(page.getByLabel('Активный рейд Проверка пропущенной точки')).toBeVisible()
    await expect(page.getByText('Завершите отметку', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Причина ручной проверки', { exact: true })).toHaveCount(0)
    Object.assign(gps, { latitude: a.latitude, longitude: a.longitude })
    await context.setGeolocation(gps)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(sheet.getByRole('heading', { name: a.name, exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(sheet.getByRole('button', { name: 'Пометить точку', exact: true })).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('point-after-reload.png') })
    const revisited = page.waitForResponse(response => response.url().endsWith(commandPath) && response.request().method() === 'POST')
    await sheet.getByRole('button', { name: 'Пометить точку', exact: true }).click()
    const success = await (await revisited).json()
    expect(success.outcome).toBe('accepted')
    expect(success.operationId).not.toBe(receipt.operationId)
    expect(success.operationId).not.toBe(legacyId)
    expect(errors).toEqual([])
  } finally { clearInterval(gpsTimer) }
})
