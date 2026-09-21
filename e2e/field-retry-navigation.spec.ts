import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../apps/api/src/database.js'
import { assertE2EDatabaseGuard, prepareE2EIdentity, requireE2EDatabaseUrl } from '../apps/api/src/e2e-fixture.js'
import { fixture, installSyntheticSession, installYandexMapsMock, type FixtureIdentity } from './support.js'
import { createDeviceContext } from './persistent-context.js'

async function operations(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kabanda-field-operations-v1')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<Array<{ operationId: string; kind: string; status: string }>>((resolve, reject) => {
        const request = db.transaction('operations').objectStore('operations').getAll()
        request.onsuccess = () => resolve(request.result.map(({ operationId, kind, status }: { operationId: string; kind: string; status: string }) => ({ operationId, kind, status })))
        request.onerror = () => reject(request.error)
      })
    } finally { db.close() }
  })
}

test('three accounts converge after automatic retries on Home while a photograph is held', async ({ browser }, info) => {
  test.setTimeout(120_000)
  const url = requireE2EDatabaseUrl(), pool = createDatabase(url)
  await assertE2EDatabaseGuard(pool)
  const owner = fixture<FixtureIdentity>('prepare')
  const nav = await prepareE2EIdentity(url, randomUUID()), rider = await prepareE2EIdentity(url, randomUUID())
  const teamId = randomUUID(), raidId = randomUUID(), collectionId = randomUUID(), pointId = randomUUID(), sourceId = randomUUID()
  const contexts: import('@playwright/test').BrowserContext[] = []
  let release!: () => void
  const uploadGate = new Promise<void>(done => { release = done })
  let uploadStarted = false, committedAt = 0
  const attempts: Array<{ key: string; body: string; url: string }> = []
  const errors: string[] = []
  try {
    await pool.query("INSERT INTO kabandas(id,name,owner_id,create_idempotency_key) VALUES($1,'Retry E2E',$2,$1::uuid::text)", [teamId, owner.userId])
    await pool.query("INSERT INTO kabanda_memberships(kabanda_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')", [teamId, owner.userId, nav.userId, rider.userId])
    await pool.query("INSERT INTO point_collections(id,kabanda_id,name) VALUES($1,$2,'Retry fixture')", [collectionId, teamId])
    await pool.query(`INSERT INTO points(id,kabanda_id,stable_key,name,location,source,source_id,source_url,license,verification_status)
      VALUES($1,$2,$1::uuid::text,'Общая остановка',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),'test',$1::uuid::text,'https://example.test','test','field_verified')`, [sourceId, teamId])
    await pool.query(`INSERT INTO raids(id,kabanda_id,organizer_user_id,navigator_user_id,title,state,started_at)
      VALUES($1,$2,$3,$4,'Повтор после ухода','active',now()-interval '1 minute')`, [raidId, teamId, owner.userId, nav.userId])
    for (const identity of [owner, nav, rider]) await pool.query("INSERT INTO raid_participants(raid_id,user_id,state,active_from) VALUES($1,$2,'active',now()-interval '1 minute')", [raidId, identity.userId])
    await pool.query(`INSERT INTO raid_point_snapshots(id,raid_id,source_point_id,collection_id,name,location,position)
      VALUES($1,$2,$3,$4,'Общая остановка',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),0)`, [pointId, raidId, sourceId, collectionId])
    await pool.query("INSERT INTO raid_activity_windows(raid_id,opened_at,opened_version) VALUES($1,now()-interval '1 minute',1)", [raidId])
    await pool.query('INSERT INTO raid_navigator_leases(raid_id,navigator_user_id,generation) VALUES($1,$2,1)', [raidId, nav.userId])
    const pages: Page[] = []
    for (const [index, identity] of [owner, nav, rider].entries()) {
      const context = await createDeviceContext(browser, { baseURL: 'http://127.0.0.1:4173', viewport: { width: 390, height: 844 },
        serviceWorkers: 'block', reducedMotion: 'reduce', permissions: ['geolocation'] })
      contexts.push(context)
      await installSyntheticSession(context, identity); await installYandexMapsMock(context)
      await context.addInitScript(({ latitude, longitude }) => {
        let next = 0
        const watches = new Map<number, ReturnType<typeof setInterval>>()
        const position = () => ({ coords: { latitude, longitude, accuracy: 8, altitude: null,
          altitudeAccuracy: null, heading: null, speed: 0 }, timestamp: Date.now() })
        Object.defineProperty(navigator.geolocation, 'getCurrentPosition', { configurable: true,
          value: (success: PositionCallback) => queueMicrotask(() => success(position() as GeolocationPosition)) })
        Object.defineProperty(navigator.geolocation, 'watchPosition', { configurable: true, value: (success: PositionCallback) => {
          const id = ++next; queueMicrotask(() => success(position() as GeolocationPosition))
          watches.set(id, setInterval(() => success(position() as GeolocationPosition), 2000)); return id
        } })
        Object.defineProperty(navigator.geolocation, 'clearWatch', { configurable: true, value: (id: number) => {
          clearInterval(watches.get(id)); watches.delete(id)
        } })
      }, { latitude: 56.86 + index * .00003, longitude: 53.21 })
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); pages.push(page)
    }
    const [ownerPage, navPage, riderPage] = pages as [Page, Page, Page]
    navPage.on('dialog', dialog => void dialog.accept())
    await navPage.route(new RegExp(`/api/raids/${raidId}/points/${pointId}/materials/[^/]+/content$`), async route => {
      if (route.request().method() !== 'PUT') return route.continue()
      uploadStarted = true; await uploadGate
      await route.continue().catch(() => {}) // The test's finally can close the waiting tab.
    })
    await navPage.route(`**/api/raids/${raidId}/check-ins/team`, async route => {
      attempts.push({ key: route.request().headers()['idempotency-key'] ?? '', body: route.request().postData() ?? '', url: navPage.url() })
      if (attempts.length === 1) return route.fulfill({ status: 503, json: { error: { code: 'TEST_TEMPORARY', message: 'Synthetic outage' } } })
      if (attempts.length === 2) {
        // Commit on the real API, then lose only the acknowledgement. The next
        // automatic retry must reconcile the same receipt, not create a visit.
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        committedAt = Date.now()
        return route.abort('failed')
      }
      return route.continue()
    })
    await Promise.all(pages.map(page => page.goto(`/app?raid=${raidId}`)))
    const panel = navPage.getByRole('region', { name: 'Командное посещение' })
    await expect(panel).toBeVisible()
    await expect(navPage.getByRole('checkbox', { name: rider.displayName, exact: true })).toBeChecked()
    await expect(navPage.getByRole('checkbox', { name: owner.displayName, exact: true })).toBeChecked()
    await navPage.getByRole('checkbox', { name: owner.displayName, exact: true }).uncheck()
    await navPage.locator('.point-materials input[type="file"]').first().setInputFiles('apps/pwa/public/pwa-192x192.png')
    await expect.poll(() => uploadStarted).toBe(true)
    await navPage.getByRole('complementary', { name: 'Подтверждение точки' }).getByRole('button', { name: 'Пометить точку', exact: true }).click()
    await expect.poll(async () => (await operations(navPage)).find(row => row.kind === 'team')?.status).toBe('retryable')
    await contexts[1]!.setOffline(true)
    await navPage.getByRole('link', { name: 'Выйти из карты рейда', exact: true }).click()
    await expect(navPage).not.toHaveURL(new RegExp(`raid=${raidId}`))
    await expect(navPage.locator('.raid-active-map')).toHaveCount(0)
    expect(attempts).toHaveLength(1)
    await contexts[1]!.setOffline(false)
    await expect.poll(() => attempts.length, { timeout: 15_000 }).toBe(3)
    await expect.poll(async () => (await operations(navPage)).find(row => row.kind === 'team')?.status, { timeout: 10_000 }).toBe('accepted')
    expect(attempts.slice(1).every(attempt => !new URL(attempt.url).searchParams.has('raid'))).toBe(true)
    expect(new Set(attempts.map(attempt => attempt.key)).size).toBe(1)
    expect(new Set(attempts.map(attempt => attempt.body)).size).toBe(1)
    for (const page of [ownerPage, riderPage]) await expect(page.getByRole('button', { name: /^Общая остановка\./ })).toHaveClass(/raid-live-point--visited/)
    expect((await pool.query('SELECT count(*)::int AS n FROM raid_checkin_attempts WHERE raid_id=$1', [raidId])).rows[0]!.n).toBe(1)
    expect((await pool.query('SELECT user_id FROM raid_point_credits WHERE raid_id=$1 ORDER BY user_id', [raidId])).rows.map(row => row.user_id).sort()).toEqual([nav.userId, rider.userId].sort())
    expect((await pool.query('SELECT ready FROM raid_point_materials WHERE raid_id=$1', [raidId])).rows[0]?.ready).toBe(false)
    release()
    await expect.poll(async () => (await pool.query('SELECT ready FROM raid_point_materials WHERE raid_id=$1', [raidId])).rows[0]?.ready).toBe(true)
    await expect.poll(async () => (await operations(navPage)).find(row => row.kind === 'photo')?.status).toBe('accepted')
    expect(errors).toEqual([])
    await info.attach('automatic-retry-evidence', { body: JSON.stringify({ realDisposableApi: true, phones: 3,
      attempts: attempts.length, samePayload: true, sameOperation: true, retryOnHome: true, committedAt, photoHeldUntilVisit: true }), contentType: 'application/json' })
  } finally {
    release(); await Promise.all(contexts.map(context => context.close())); await pool.end()
  }
})
