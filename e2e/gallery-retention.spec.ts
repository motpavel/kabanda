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
  const state = { deny: false, failLater: false, newPhoto: false, requests: 0, laterRequests: 0 }
  const image = readFileSync('apps/pwa/public/pwa-192x192.png')
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (path.endsWith('/content')) return route.fulfill({ contentType: 'image/png', body: image })
    if (path.endsWith('/share-card')) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Synthetic share-card outage' } } })
    if (path.endsWith('/media')) {
      state.requests++
      const offset = Number(url.searchParams.get('cursor') ?? 0)
      if (offset) state.laterRequests++
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
      : path.endsWith('/live') || path === `/api/raids/${raidId}` ? { raid, points: [], track: { segments: [], pointCount: 0, truncated: false, updatedAt: null, serverAt: new Date().toISOString() } }
      : path.endsWith('/map-points') ? { points: [] } : {}
    return route.fulfill({ json: body })
  })
  return state
}

test('focus refresh and a failed second page preserve mounted photos; retry includes the old tail after new arrivals', async ({ page, context }, info) => {
  await installYandexMapsMock(context)
  const state = await mockGallery(page)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(`/app?raid=${raidId}`)
  const gallery = page.getByRole('region', { name: 'Фотографии завершённого рейда' })
  const images = gallery.locator('.result-gallery__grid img')
  await expect(images).toHaveCount(24)
  await gallery.getByRole('button', { name: 'Показать ещё фотографии' }).click()
  await expect(images).toHaveCount(48)
  const last = gallery.getByAltText('Снимок 48', { exact: true })
  await last.scrollIntoViewIfNeeded()
  await page.evaluate(() => { (window as any).retainedGalleryTail = document.querySelector('img[alt="Снимок 48"]') })
  state.failLater = true
  const before = state.laterRequests
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect.poll(() => state.laterRequests).toBeGreaterThan(before)
  await expect(gallery.getByRole('button', { name: 'Повторить загрузку фотографий' })).toBeEnabled()
  await expect(images).toHaveCount(48)
  await expect(last).toBeAttached()
  expect(await page.evaluate(() => (window as any).retainedGalleryTail === document.querySelector('img[alt="Снимок 48"]'))).toBe(true)
  state.failLater = false; state.newPhoto = true
  await gallery.getByRole('button', { name: 'Повторить загрузку фотографий' }).click()
  await expect(images).toHaveCount(49)
  await expect(gallery.getByAltText('Снимок 0', { exact: true })).toBeAttached()
  await expect(last).toBeAttached()
  expect(await page.evaluate(() => (window as any).retainedGalleryTail === document.querySelector('img[alt="Снимок 48"]'))).toBe(true)
  await expect(gallery.getByRole('button', { name: 'Показать ещё фотографии' })).toHaveCount(0)
  expect(errors).toEqual([])
  await info.attach('gallery-retention', { body: JSON.stringify({ pagesRetained: 2, photosBefore: 48, photosAfter: 49, tailNodePreserved: true }), contentType: 'application/json' })
})

test('access denial discards the retained gallery instead of treating it as a retryable page failure', async ({ page, context }) => {
  await installYandexMapsMock(context)
  const state = await mockGallery(page)
  await page.goto(`/app?raid=${raidId}`)
  const gallery = page.getByRole('region', { name: 'Фотографии завершённого рейда' })
  await expect(gallery.locator('img')).toHaveCount(24)
  await gallery.getByRole('button', { name: 'Показать ещё фотографии' }).click()
  await expect(gallery.locator('img')).toHaveCount(48)
  state.deny = true
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.locator('.result-shell')).toContainText('Результат недоступен для просмотра.')
  await expect(gallery.locator('img')).toHaveCount(0)
  await expect(page.locator('.result-share')).toHaveCount(0)
})
