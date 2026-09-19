import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../apps/api/src/database.js'
import { assertE2EDatabaseGuard, prepareE2EIdentity, requireE2EDatabaseUrl } from '../apps/api/src/e2e-fixture.js'
import { api, fixture, installSyntheticSession, installYandexMapsMock, type FixtureIdentity } from './support.js'

// Real auth cookies, API routes and a guarded disposable PostgreSQL database.
// Only GPS, the map provider and one delayed upload connection are synthetic.
test('navigator visit reaches three open phones independently of a photo and survives finish', async ({ browser }, info) => {
  test.setTimeout(120_000)
  const url = requireE2EDatabaseUrl()
  const pool = createDatabase(url)
  await assertE2EDatabaseGuard(pool)
  const owner = fixture<FixtureIdentity>('prepare')
  const nav = await prepareE2EIdentity(url, randomUUID())
  const rider = await prepareE2EIdentity(url, randomUUID())
  const teamId = randomUUID(), raidId = randomUUID(), collectionId = randomUUID(), pointId = randomUUID(), sourceId = randomUUID()
  const contexts: import('@playwright/test').BrowserContext[] = []
  let releaseUpload!: () => void
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve })
  let uploadStarted = false
  try {
    await pool.query("INSERT INTO kabandas(id,name,owner_id,create_idempotency_key) VALUES($1,'Field E2E',$2,$1::uuid::text)", [teamId, owner.userId])
    await pool.query("INSERT INTO kabanda_memberships(kabanda_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')", [teamId, owner.userId, nav.userId, rider.userId])
    await pool.query("INSERT INTO point_collections(id,kabanda_id,name) VALUES($1,$2,'Field fixture')", [collectionId, teamId])
    await pool.query(`INSERT INTO points(id,kabanda_id,stable_key,name,location,source,source_id,source_url,license,verification_status)
      VALUES($1,$2,$1::uuid::text,'Общая остановка',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),'test',$1::uuid::text,'https://example.test','test','field_verified')`, [sourceId, teamId])
    await pool.query(`INSERT INTO raids(id,kabanda_id,organizer_user_id,navigator_user_id,title,state,started_at)
      VALUES($1,$2,$3,$4,'Три телефона','active',now()-interval '1 minute')`, [raidId, teamId, owner.userId, nav.userId])
    for (const identity of [owner, nav, rider]) await pool.query("INSERT INTO raid_participants(raid_id,user_id,state,active_from) VALUES($1,$2,'active',now()-interval '1 minute')", [raidId, identity.userId])
    await pool.query(`INSERT INTO raid_point_snapshots(id,raid_id,source_point_id,collection_id,name,location,position)
      VALUES($1,$2,$3,$4,'Общая остановка',ST_SetSRID(ST_MakePoint(53.21,56.86),4326),0)`, [pointId, raidId, sourceId, collectionId])
    await pool.query("INSERT INTO raid_activity_windows(raid_id,opened_at,opened_version) VALUES($1,now()-interval '1 minute',1)", [raidId])
    await pool.query('INSERT INTO raid_navigator_leases(raid_id,navigator_user_id,generation) VALUES($1,$2,1)', [raidId, nav.userId])
    const pages: import('@playwright/test').Page[] = []
    const errors: string[] = []
    for (const [index, identity] of [owner, nav, rider].entries()) {
      const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', viewport: { width: 390, height: 844 },
        serviceWorkers: 'block', reducedMotion: 'reduce', permissions: ['geolocation'] })
      contexts.push(context)
      await installSyntheticSession(context, identity)
      await installYandexMapsMock(context)
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
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      pages.push(page)
    }
    const [ownerPage, navPage, riderPage] = pages as [import('@playwright/test').Page, import('@playwright/test').Page, import('@playwright/test').Page]
    await navPage.route(new RegExp(`/api/raids/${raidId}/points/${pointId}/materials/[^/]+/content$`), async route => {
      if (route.request().method() !== 'PUT') return route.continue()
      uploadStarted = true
      await uploadGate
      await route.continue()
    })
    await Promise.all(pages.map(page => page.goto(`/app?raid=${raidId}`)))
    await expect(navPage.getByRole('region', { name: 'Командное посещение' })).toBeVisible()
    await expect(navPage.getByRole('checkbox', { name: rider.displayName, exact: true })).toBeChecked()
    await expect(navPage.getByRole('checkbox', { name: owner.displayName, exact: true })).toBeChecked()
    await navPage.getByRole('checkbox', { name: owner.displayName, exact: true }).uncheck()
    await navPage.locator('.point-materials input[type="file"]').first().setInputFiles('apps/pwa/public/pwa-192x192.png')
    await expect.poll(() => uploadStarted).toBe(true)
    const start = Date.now()
    await navPage.getByRole('region', { name: 'Командное посещение' }).getByRole('button', { name: 'Пометить точку', exact: true }).click()
    for (const page of pages) await expect(page.getByRole('button', { name: /^Общая остановка\./ })).toHaveClass(/raid-live-point--visited/, { timeout: 8000 })
    const propagationMs = Date.now() - start
    expect(propagationMs).toBeLessThan(8000)
    // The photo connection is still held, so success cannot have waited for it.
    expect((await pool.query('SELECT ready FROM raid_point_materials WHERE raid_id=$1', [raidId])).rows[0]?.ready).toBe(false)
    const credits = (await pool.query('SELECT user_id FROM raid_point_credits WHERE raid_id=$1 ORDER BY user_id', [raidId])).rows
    expect(credits.map(row => row.user_id).sort()).toEqual([nav.userId, rider.userId].sort())
    expect((await pool.query('SELECT count(*)::int AS n FROM raid_checkin_attempts WHERE raid_id=$1', [raidId])).rows[0]!.n).toBe(1)
    expect((await pool.query('SELECT count(*)::int AS n FROM raid_checkin_claims WHERE raid_id=$1', [raidId])).rows[0]!.n).toBe(0)
    await ownerPage.getByRole('button', { name: /^Общая остановка\./ }).click()
    const history = ownerPage.getByRole('complementary', { name: 'История точки: Общая остановка' })
    await expect(history).toBeVisible()
    await expect(history.getByRole('button', { name: /Пометить|Новый визит/ })).toHaveCount(0)
    await expect(history.getByRole('button', { name: 'Добавить комментарий' })).toBeVisible()
    // Renewing the same identity must reconnect a mounted live screen, not
    // strand it on a retired feed with permanently empty data.
    const liveAfterRenewal = riderPage.waitForResponse(response => response.url().includes(`/api/raids/${raidId}/fast/live`) && response.ok())
    await riderPage.evaluate(userId => window.dispatchEvent(new CustomEvent('kabanda:identity-changed', { detail: { userId } })), rider.userId)
    await liveAfterRenewal
    await expect(riderPage.getByRole('button', { name: /^Общая остановка\./ })).toHaveClass(/raid-live-point--visited/)
    releaseUpload()
    await expect.poll(async () => (await pool.query('SELECT ready FROM raid_point_materials WHERE raid_id=$1', [raidId])).rows[0]?.ready).toBe(true)
    const pending = (await pool.query('SELECT request_fingerprint FROM raid_feature_receipts WHERE raid_id=$1 AND command=$2', [raidId, 'team-visit-v1'])).rows
    expect(pending).toHaveLength(1)
    const current = await api<{ raid: { version: number } }>(ownerPage, 'GET', `/api/raids/${raidId}`)
    const finishing = await api<{ raid: { version: number } }>(ownerPage, 'POST', `/api/raids/${raidId}/commands/finish`, {
      expectedVersion: current.raid.version, inventory: { routePending: 0, checkInsPending: 0, mediaPending: 0, needsAction: 0 }, confirmPartial: false,
    }, randomUUID())
    await api(ownerPage, 'POST', `/api/raids/${raidId}/finalization/settle`, { expectedVersion: finishing.raid.version }, randomUUID())
    const before = (await pool.query('SELECT result_json,share_sha256 FROM raid_results WHERE raid_id=$1', [raidId])).rows[0]
    await navPage.goto(`/app?raid=${raidId}`)
    await expect(navPage.getByRole('heading', { name: 'Итоги рейда' })).toBeAttached()
    await navPage.locator('.result-route__points button').filter({ hasText: 'Общая остановка' }).click()
    const materials = navPage.getByRole('region', { name: 'Фото и комментарии точки' })
    await expect(materials.getByRole('img', { name: 'Фото точки' })).toBeVisible()
    await materials.getByLabel('Комментарий или подпись к фото').fill('Добавлено после финиша')
    await materials.getByRole('button', { name: 'Добавить комментарий' }).click()
    await expect(materials.getByText('Добавлено после финиша', { exact: true })).toBeVisible()
    expect((await pool.query('SELECT result_json,share_sha256 FROM raid_results WHERE raid_id=$1', [raidId])).rows[0]).toEqual(before)
    expect(errors).toEqual([])
    await navPage.screenshot({ path: info.outputPath('completed-point-materials.png'), fullPage: true })
    await info.attach('propagation-measurement', { body: JSON.stringify({ syntheticDirectApi: true, propagationMs, phones: 3, uploadHeldUntilVisit: true }), contentType: 'application/json' })
  } finally {
    releaseUpload()
    await Promise.all(contexts.map(context => context.close()))
    await pool.end()
  }
})
