import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { userSchema } from '../packages/contracts/src/index.js'
import { installYandexMapsMock } from './support.js'
import type { RaidProjection } from '../apps/pwa/src/features/raids/types.js'

const userId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const raidId = '33333333-3333-4333-8333-333333333333'
const user = userSchema.parse({ id: userId, displayName: 'Галерея', username: 'gallery-qa', email: 'gallery@example.test', identityKind: 'verified', avatarUrl: null })
const metrics = { durationSeconds: 600, distanceMeters: 1000, uniquePoints: 1, photos: 48 }
const raid: RaidProjection = { id: raidId, kabandaId: teamId, title: 'Галерея после возврата', state: 'completed', version: 3,
  scheduledAt: null, description: null, organizerUserId: userId, navigatorUserId: userId,
  navigatorReady: true, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  participants: [{ id: userId, displayName: 'Галерея', avatarUrl: null, state: 'active' }], allowedActions: [],
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null } }
const photo = (number: number) => ({ id: `44444444-4444-4444-8444-${String(number).padStart(12, '0')}`, state: 'ready',
  contentType: 'image/jpeg', sizeBytes: 100, width: 96, height: 96, caption: `Снимок ${number}`, purpose: 'gallery',
  createdAt: '2026-09-19T12:00:00Z', uploaderUserId: userId })

test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' })
async function mockGallery(page: Page) {
  const state = { deny: false, failLater: false, newPhoto: false, requests: 0, laterRequests: 0,
    liveReads: [] as number[], materialRequests: 0, staticTrack: true, trackReads: 0, routePoints: 1, failReads: false, holdLive: null as Promise<void> | null, holdHead: null as Promise<void> | null, holdImages: null as Promise<void> | null }
  const image = readFileSync('apps/pwa/public/pwa-192x192.png')
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (state.failReads && !['/api/me', '/api/kabandas'].includes(path)) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'offline reads' } } })
    if (path.endsWith('/live')) { state.liveReads.push(state.routePoints); if (state.holdLive) await state.holdLive }
    if (path.endsWith('/route/track')) {
      state.trackReads++
      return route.fulfill({ json: { track: { segments: [], pointCount: state.routePoints, truncated: false, updatedAt: '2026-09-19T12:00:00Z', serverAt: new Date().toISOString() } } })
    }
    if (path.endsWith('/materials')) {
      state.materialRequests++
      return route.fulfill({ json: { materials: [{ id: 'comment', pointSnapshotId: 'point', authorUserId: userId, authorName: 'Галерея', kind: 'comment', body: 'Сохранённый комментарий', ready: true, width: null, height: null, createdAt: '2026-09-19T12:00:00Z' }], nextCursor: null, canWrite: true } })
    }
    if (path.endsWith('/content')) {
      if (state.holdImages) await state.holdImages
      return route.fulfill({ contentType: 'image/png', body: image })
    }
    if (path.endsWith('/share-card')) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Synthetic share-card outage' } } })
    if (path.endsWith('/media')) {
      state.requests++
      const offset = Number(url.searchParams.get('cursor') ?? 0)
      if (offset) state.laterRequests++
      if (!offset && state.holdHead) await state.holdHead
      if (state.deny || offset && state.failLater) return route.fulfill({ status: state.deny ? 403 : 503,
        json: { error: { code: state.deny ? 'FORBIDDEN' : 'UNAVAILABLE', message: 'Synthetic gallery failure' } } })
      const images = Array.from({ length: 48 }, (_, i) => photo(i + 1))
      if (state.newPhoto) images.unshift(photo(0))
      return route.fulfill({ json: { media: images.slice(offset, offset + 24), nextCursor: offset + 24 < images.length ? String(offset + 24) : null } })
    }
    const body = path === '/api/me' ? { user }
      : path === '/api/kabandas' ? { kabandas: [{ id: teamId, name: 'Галерея', role: 'member', avatar: '🐗', coverImage: null, memberCount: 1, pointsCollectionId: null }] }
      : path.endsWith('/result') ? { result: { schemaVersion: 1,
        raid: { id: raidId, kabandaId: teamId, title: raid.title, startedAt: '2026-09-19T12:00:00Z', completedAt: '2026-09-19T12:10:00Z', partial: true },
        personal: metrics, team: metrics, participants: [{ userId, displayName: user.displayName, metrics }] } }
      : path.endsWith('/raids/history/page') ? { schemaVersion: 2, scope: url.searchParams.get('scope') ?? 'all', raids: [], nextCursor: null }
      : path.endsWith('/raids') ? { raids: [] }
      : path.includes('templates') ? { templates: [], nextCursor: null }
      : path.endsWith('/progress') ? { progress: { personal: { ...metrics, completedRaids: 1 }, team: { ...metrics, completedRaids: 1 } } }
      : path.endsWith('/members') ? { members: [{ id: userId, displayName: user.displayName, role: 'member', avatarUrl: null }] }
      : path.endsWith('/live') || path === `/api/raids/${raidId}` ? { raid: { ...raid, routeStatus: { ...raid.routeStatus, acceptedSampleCount: state.routePoints } }, teamVisits: state.staticTrack, points: [{ id: 'point', sourcePointId: 'source', name: 'Сохранённая точка', latitude: 56.86, longitude: 53.21, position: 0, visitedByMe: true, visitedByTeam: true }], ...(state.staticTrack ? { track: { segments: [], pointCount: 0, truncated: false, updatedAt: null, serverAt: new Date().toISOString() } } : {}) }
      : path.endsWith('/map-points') ? { points: [] } : {}
    return route.fulfill({ json: body })
  })
  return state
}


async function snapshots(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('kabanda-raid-reads-v1'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error)
    })
    try { return await new Promise<any[]>((resolve, reject) => {
      const read = db.transaction('snapshots').objectStore('snapshots').getAll(); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error)
    }) } finally { db.close() }
  })
}

test('reopening a visited point reuses its materials without another request', async ({ page, context }) => {
  await installYandexMapsMock(context)
  const state = await mockGallery(page)
  await page.goto(`/app?raid=${raidId}`)
  const point = page.getByRole('button', { name: '1 Сохранённая точка', exact: true })
  await point.click()
  await expect(page.locator('.point-materials__item')).toContainText('Сохранённый комментарий')
  const reads = state.materialRequests
  await point.click(); await point.click()
  await expect(page.locator('.point-materials__item')).toContainText('Сохранённый комментарий')
  expect(state.materialRequests).toBe(reads)
  await page.clock.install()
  await page.clock.fastForward(15_000)
  expect(state.materialRequests).toBe(reads) // completed materials no longer poll every five seconds
})

test('reload shows saved points, materials, both gallery pages and photo bytes while reads fail', async ({ page, context }) => {
  await installYandexMapsMock(context)
  const state = await mockGallery(page)
  await page.goto(`/app?raid=${raidId}`)
  const point = page.getByRole('button', { name: '1 Сохранённая точка', exact: true })
  await point.click()
  await expect(page.locator('.point-materials__item')).toContainText('Сохранённый комментарий')
  const gallery = page.getByRole('region', { name: 'Фотографии завершённого рейда' })
  await gallery.getByRole('button', { name: 'Показать ещё фотографии' }).click()
  await expect(gallery.locator('img')).toHaveCount(48)
  const first = gallery.locator('img').first()
  await first.scrollIntoViewIfNeeded()
  await expect.poll(() => first.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect.poll(async () => (await snapshots(page)).some(row => row.value.pageCount === 2 && row.value.items.length === 48)).toBe(true)
  state.failReads = true
  await page.reload()
  await expect(point).toBeVisible()
  await point.click()
  await expect(page.locator('.point-materials__item')).toContainText('Сохранённый комментарий')
  await expect(page.getByRole('button', { name: 'Комментарий', exact: true })).toHaveCount(0)
  await expect(gallery.locator('img')).toHaveCount(48)
  await first.scrollIntoViewIfNeeded()
  await expect.poll(() => first.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByText(/Сохранённая копия от/).first()).toBeVisible()
})

test('cached points appear before a held live response after reload', async ({ page, context }) => {
  await installYandexMapsMock(context)
  const state = await mockGallery(page)
  await page.goto(`/app?raid=${raidId}`)
  await expect(page.locator('.result-route__points')).toContainText('Сохранённая точка')
  await expect.poll(async () => (await snapshots(page)).some(row => row.value.points?.[0]?.id === 'point')).toBe(true)
  let release!: () => void
  state.holdLive = new Promise<void>(resolve => { release = resolve })
  try {
    await page.reload()
    await expect(page.locator('.result-route__points')).toContainText('Сохранённая точка')
  } finally { state.holdLive = null; release() }
})

async function cachedRouteRevision(page: Page) {
  return page.evaluate(async ({ identity, raid }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('kabanda-offline'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error)
    })
    try { return await new Promise<string | null>((resolve, reject) => {
      const read = db.transaction('raidMapCache').objectStore('raidMapCache').get(JSON.stringify([identity, raid]));
      read.onsuccess = () => resolve(read.result?.snapshotRevision ?? null); read.onerror = () => reject(read.error)
    }) } finally { db.close() }
  }, { identity: userId, raid: raidId })
}
test('a verified unchanged completed track survives reload without downloading its geometry again', async ({ page, context }) => {
  await page.clock.install()
  await installYandexMapsMock(context)
  const state = await mockGallery(page); state.staticTrack = false
  await page.goto(`/app?raid=${raidId}`)
  await expect.poll(() => state.trackReads).toBe(1)
  await expect.poll(() => cachedRouteRevision(page)).not.toBeNull()
  await page.reload()
  await expect(page.locator('.result-route__points')).toContainText('Сохранённая точка')
  await expect.poll(async () => (await snapshots(page)).some(row => row.value.raid?.id === raidId && row.value.points?.length)).toBe(true)
  expect(state.trackReads).toBe(1)
  await page.clock.fastForward(1500)
  state.routePoints = 2
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => state.trackReads).toBe(2)
})
