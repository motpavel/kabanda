import { expect, test, type Page } from '@playwright/test'
import { api, fixture, installSyntheticSession, installYandexMapsMock, operationId, type FixtureIdentity } from './support.js'
import { installRecorderGpsProbe } from './recorder-gps-probe.js'

async function maxSavedSequence(page: Page, raidId: string): Promise<number> {
  return page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kabanda-offline')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const rows = await new Promise<Array<{ raidId: string; sequence: number }>>((resolve, reject) => {
        const request = db.transaction('routeOutbox').objectStore('routeOutbox').getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      return Math.max(0, ...rows.filter(row => row.raidId === id).map(row => row.sequence))
    } finally { db.close() }
  }, raidId)
}

test('refusing link and browser Back keeps the recording map mounted; accepting does not finish the raid', async ({ page, context }) => {
  const identity = fixture<FixtureIdentity>('prepare')
  await installYandexMapsMock(context)
  await installSyntheticSession(context, identity)
  const team = await api<{ kabanda: { id: string } }>(page, 'POST', '/api/kabandas', { name: `Trust ${identity.runId.slice(0, 8)}`, avatar: '🚲' }, operationId('team'))
  fixture('attach-point', team.kabanda.id)
  let raid = (await api<{ raid: { id: string; version: number } }>(page, 'POST', `/api/kabandas/${team.kabanda.id}/raids`, { title: 'Recording navigation', description: null, scheduledAt: null }, operationId('raid'))).raid
  for (const command of ['open-lobby', 'assign-navigator'] as const) {
    raid = (await api<{ raid: typeof raid }>(page, 'POST', `/api/raids/${raid.id}/commands/${command}`, {
      expectedVersion: raid.version, ...(command === 'assign-navigator' ? { navigatorUserId: identity.userId } : {}),
    }, operationId(command))).raid
  }
  raid = (await api<{ raid: typeof raid }>(page, 'POST', `/api/raids/${raid.id}/participants/me/ready`, { expectedVersion: raid.version }, operationId('ready'))).raid
  const measuredAt = new Date().toISOString()
  raid = (await api<{ raid: typeof raid }>(page, 'POST', `/api/raids/${raid.id}/readiness`, {
    expectedVersion: raid.version, appMode: 'browser', locationPermission: 'granted', coordinateMeasuredAt: measuredAt,
    accuracyM: 8, indexedDbWritable: true, storageAvailable: true, online: true, measuredAt,
  }, operationId('readiness'))).raid
  await api(page, 'PUT', `/api/raids/${raid.id}/presence/me`, { ...identity.point, capturedAt: new Date().toISOString(), accuracyMeters: 8 })
  raid = (await api<{ raid: typeof raid }>(page, 'POST', `/api/raids/${raid.id}/commands/start`, { expectedVersion: raid.version }, operationId('start'))).raid

  await page.goto(`/app?kabanda=${team.kabanda.id}`)
  await installRecorderGpsProbe(page, identity.point)
  await page.getByRole('link', { name: 'Вернуться в рейд', exact: true }).click()
  const map = page.getByRole('region', { name: 'Активный рейд Recording navigation', exact: true })
  await expect(map).toBeVisible()
  await expect(map).toContainText('Маршрут записывается', { timeout: 20_000 })
  await expect.poll(() => maxSavedSequence(page, raid.id), { timeout: 20_000 }).toBeGreaterThan(0)
  await page.evaluate(() => { Object.assign(window, { trustMapNode: document.querySelector('.raid-active-map') }) })
  const before = await maxSavedSequence(page, raid.id)

  const linkDialog = page.waitForEvent('dialog')
  const linkClick = page.getByRole('link', { name: 'Выйти из карты рейда', exact: true }).click()
  const prompt = await linkDialog
  expect(prompt.message()).toContain('Сам рейд не завершится')
  await prompt.dismiss()
  await linkClick
  await expect(page).toHaveURL(new RegExp(`raid=${raid.id}`))
  await expect(map).toBeVisible()

  const backDialog = page.waitForEvent('dialog')
  await page.evaluate(() => window.history.back())
  await (await backDialog).dismiss()
  await expect(page).toHaveURL(new RegExp(`raid=${raid.id}`))
  await expect(map).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { trustMapNode: Element }).trustMapNode === document.querySelector('.raid-active-map'))).toBe(true)
  await expect.poll(() => maxSavedSequence(page, raid.id), { timeout: 20_000 }).toBeGreaterThan(before)

  const acceptedBack = page.waitForEvent('dialog')
  await page.evaluate(() => window.history.back())
  await (await acceptedBack).accept()
  await expect(page).toHaveURL(new RegExp(`kabanda=${team.kabanda.id}`))
  await expect(map).toHaveCount(0)
  const latest = await api<{ raid: { state: string } }>(page, 'GET', `/api/raids/${raid.id}`)
  expect(latest.raid.state).toBe('active')
  expect(await maxSavedSequence(page, raid.id)).toBeGreaterThanOrEqual(before)
})
