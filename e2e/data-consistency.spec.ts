import { test, expect, type Page } from '@playwright/test'

const userId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const raidId = '33333333-3333-4333-8333-333333333333'
const user = { id: userId, email: 'synthetic@example.test', username: 'synthetic', displayName: 'Тестовый участник', avatarUrl: null, identityKind: 'verified' }
const team = { id: teamId, name: 'Тестовая Кабанда', avatar: '🐗', coverImage: null, role: 'member', memberCount: 2, pointsCollectionId: null }
const invited = {
  id: raidId, kabandaId: teamId, title: 'Проверка согласованности', state: 'lobby', version: 4,
  scheduledAt: null, description: null, organizerUserId: '44444444-4444-4444-8444-444444444444', navigatorUserId: null,
  navigatorReady: false, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null },
  participants: [{ id: userId, displayName: 'Тестовый участник', avatarUrl: null, state: 'invited' }], allowedActions: ['accept', 'decline'],
}
const accepted = { ...invited, participants: [{ ...invited.participants[0], state: 'accepted' }], allowedActions: ['ready', 'leave'] }
const metrics = { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0, completedRaids: 0 }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

async function mockApi(page: Page, list: () => Promise<unknown[]>, command = async () => accepted) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    let body: unknown = {}
    if (path === '/api/me') body = { user }
    else if (path === '/api/kabandas') body = { kabandas: [team] }
    else if (path.endsWith('/participants/me/accept')) body = { raid: await command() }
    else if (path.endsWith('/raids') && url.searchParams.get('scope') === 'actionable') body = { raids: await list() }
    else if (path.endsWith('/raids/history')) body = { raids: [], nextCursor: null }
    else if (path.endsWith('/progress')) body = { progress: { team: metrics, personal: metrics } }
    else if (path.endsWith('/members')) body = { members: [{ id: userId, displayName: user.displayName, role: 'member', avatarUrl: null }] }
    else if (path.includes('templates')) body = { templates: [], nextCursor: null }
    else if (path.endsWith('/live')) body = { raid: accepted }
    else if (path.endsWith('/points')) body = { points: [] }
    await route.fulfill({ json: body })
  })
}

// Watches every DOM mutation, including intermediate renders between assertions.
async function recordVisibleText(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as { consistencyFrames: string[] }
    state.consistencyFrames = []
    const sample = () => state.consistencyFrames.push(document.body.innerText)
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true })
    sample()
  })
}

test('confirmed invitation survives a late old list and immediate tab switches', async ({ page }, info) => {
  const oldList = deferred(), listStarted = deferred(), freshList = deferred()
  let calls = 0, confirmed = false
  await mockApi(page, async () => {
    calls++
    if (calls === 2) { listStarted.resolve(); await oldList.promise; return [invited] }
    if (confirmed) { await freshList.promise; return [accepted] }
    return [invited]
  }, async () => { confirmed = true; return accepted })
  await page.goto(`/app?kabanda=${teamId}`)
  await expect(page.getByText('Вас ждут в рейде')).toBeVisible()
  await page.getByRole('link', { name: 'Рейды', exact: true }).click()
  await listStarted.promise
  await expect(page.getByRole('button', { name: 'Принять', exact: true })).toBeEnabled()
  await page.screenshot({ path: info.outputPath('01-before.png') })
  await page.getByRole('button', { name: 'Принять', exact: true }).click()
  await expect(page.getByText('Вы участвуете в рейде', { exact: false })).toBeVisible()
  await recordVisibleText(page)
  await page.getByRole('link', { name: 'Главная', exact: true }).click()
  await expect(page.getByText('Вас ждут в рейде')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: invited.title })).toBeVisible()
  await page.screenshot({ path: info.outputPath('02-confirmed-home.png') })
  oldList.resolve()
  await page.getByRole('link', { name: 'Рейды', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Принять', exact: true })).toHaveCount(0)
  await expect(page.getByText('Вы едете', { exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('03-after-late-response.png') })
  const frames = await page.evaluate(() => (window as unknown as { consistencyFrames: string[] }).consistencyFrames)
  expect(frames.every(text => !text.includes('Вас ждут в рейде') && !text.includes('Нужно ответить'))).toBe(true)
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('kabanda-raid-reads-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const rows = await new Promise<any[]>((resolve) => { const r = db.transaction('snapshots').objectStore('snapshots').getAll(); r.onsuccess = () => resolve(r.result) })
    db.close()
    return rows.filter(row => row.key.includes('actionable')).map(row => row.value[0]?.participants[0]?.state)
  })).toEqual(['accepted'])
  freshList.resolve()
})

test('empty server list survives reload with unavailable raid API and a verified session', async ({ page }, info) => {
  let empty = false
  await mockApi(page, async () => empty ? [] : [invited])
  await page.goto(`/app?kabanda=${teamId}`)
  await expect(page.getByText('Вас ждут в рейде')).toBeVisible()
  empty = true
  await page.getByRole('link', { name: 'Рейды', exact: true }).click()
  await expect(page.getByTestId('production-raid-invitations')).toHaveCount(0)
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('kabanda-raid-reads-v1'); r.onsuccess = () => resolve(r.result) })
    const rows = await new Promise<any[]>(resolve => { const r = db.transaction('snapshots').objectStore('snapshots').getAll(); r.onsuccess = () => resolve(r.result) })
    db.close(); return rows.find(row => row.key.includes('actionable'))?.value.length
  })).toBe(0)
  // Offline API; assets remain served locally so reload exercises IndexedDB, not HTTP cache.
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    return path === '/api/me' || path === '/api/kabandas' ? route.fallback() : route.abort('internetdisconnected')
  })
  await page.reload()
  await expect(page.getByTestId('production-raids-hub')).toBeVisible()
  await expect(page.getByText('Не удалось обновить данные.', { exact: true })).toBeVisible()
  await expect(page.getByTestId('production-raid-invitations')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('empty-offline.png') })
})
