import { expect, test, type Page } from '@playwright/test'
import { userSchema } from '../packages/contracts/src/index.js'
import { readFileSync } from 'node:fs'
import { renderRaidShareCard } from '../apps/api/src/raid-share-card.js'
import { installYandexMapsMock } from './support.js'
import type { RaidProjection } from '../apps/pwa/src/features/raids/types.js'
import type { RaidResult } from '../apps/pwa/src/features/results/types.js'

const userId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const raidId = '33333333-3333-4333-8333-333333333333'
const photoId = '55555555-5555-4555-8555-555555555555'
// Use the same contract as session verification. A malformed fixture must fail
// here, not disguise itself as eight unrelated layout timeouts at the login screen.
const user = userSchema.parse({ id: userId, displayName: 'Участник', username: 'layout-qa',
  email: 'qa@example.test', identityKind: 'verified', avatarUrl: null })
const metrics = { durationSeconds: 600, distanceMeters: 1500, uniquePoints: 1, photos: 1 }
const base: RaidProjection = {
  id: raidId, kabandaId: teamId, title: 'Поездка на набережную', state: 'completed', version: 3,
  scheduledAt: null, description: null, organizerUserId: userId, navigatorUserId: userId,
  navigatorReady: true, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  participants: [{ id: userId, displayName: 'Участник', avatarUrl: null, state: 'active' }], allowedActions: [],
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null },
}
const result: RaidResult = { schemaVersion: 1, raid: { id: raidId, kabandaId: teamId, title: base.title,
  startedAt: '2026-09-16T12:00:00Z', completedAt: '2026-09-16T12:10:00Z', partial: true },
  team: metrics, personal: metrics, participants: [{ userId, displayName: 'Участник', metrics }] }

test.use({ reducedMotion: 'reduce', serviceWorkers: 'block' })
async function prepare(page: Page, planned = false) {
  // Use the production renderer, whose native dependency belongs to apps/api.
  // Do not require an undeclared root-workspace sharp dependency just for tests.
  const card = await renderRaidShareCard(result)
  const photo = readFileSync('apps/pwa/public/brand/kabanda-team-cover.jpg')
  const raid = planned ? { ...base, state: 'planned', scheduledAt: new Date(Date.now() + 7 * 86400_000).toISOString() } : base
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (path.endsWith('/share-card')) return route.fulfill({ contentType: 'image/png', body: card })
    if (path.endsWith('/content')) return route.fulfill({ contentType: 'image/jpeg', body: photo })
    const body = path === '/api/me' ? { user }
      : path === '/api/kabandas' ? { kabandas: [{ id: teamId, name: 'Проверка размеров', role: 'member', avatar: '🐗', coverImage: null, memberCount: 1, pointsCollectionId: null }] }
      : path.endsWith('/result') ? { result }
      : path.endsWith('/media') ? { media: [{ id: photoId, state: 'ready', contentType: 'image/jpeg', sizeBytes: photo.length,
          width: 1792, height: 896, caption: 'Снимок из завершённого рейда', purpose: 'gallery', createdAt: '2026-09-16T12:05:00Z', uploaderUserId: userId }], nextCursor: null }
      : path.endsWith('/raids/history/page') ? { schemaVersion: 2, scope: url.searchParams.get('scope') ?? 'all', raids: [], nextCursor: null }
      : path.endsWith('/raids') ? { raids: planned ? [raid] : [] }
      : path.includes('templates') ? { templates: [1, 2].map(index => ({
          id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`, kabandaId: teamId, scope: 'kabanda',
          title: `Маршрут ${index}`, version: 1, cover: { url: '/brand/kabanda-team-cover.jpg', sha256: 'a'.repeat(64), width: 1792, height: 896 },
          pointCount: 2, estimate: { method: 'straight_segments', distanceMeters: 1500 }, createdAt: '2026-09-01T12:00:00Z', updatedAt: '2026-09-01T12:00:00Z',
        })), nextCursor: null }
      : path.endsWith('/progress') ? { progress: { personal: { ...metrics, completedRaids: 1 }, team: { ...metrics, completedRaids: 1 } } }
      : path.endsWith('/members') ? { members: [{ id: userId, displayName: 'Участник', role: 'member', avatarUrl: null }] }
      : path.endsWith('/live') || path === `/api/raids/${raidId}` ? { raid,
          track: { segments: [], pointCount: 0, truncated: false, updatedAt: null, serverAt: new Date().toISOString() }, points: [] }
      : path.endsWith('/map-points') ? { points: [] } : {}
    return route.fulfill({ json: body })
  })
}

for (const width of [320, 390, 430, 1024]) {
  test(`partial result shows photographs without a giant warning or share-card gap at ${width}px`, async ({ page, context }, info) => {
    await page.setViewportSize({ width, height: 844 })
    await installYandexMapsMock(context)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await prepare(page)
    await page.goto(`/app?raid=${raidId}`)
    const summary = page.locator('.result-data-details')
    await expect(summary.locator('summary')).toHaveText('Сведения об итогах')
    await expect(summary).not.toHaveAttribute('open', '')
    await expect(page.locator('.result-shell .kb-notice').filter({ hasText: 'Неполный итог' })).toHaveCount(0)
    const photo = page.getByRole('img', { name: 'Снимок из завершённого рейда', exact: true })
    await photo.scrollIntoViewIfNeeded()
    await expect(photo).toBeVisible()
    await expect.poll(() => photo.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true)
    const image = page.getByRole('img', { name: 'Карточка с итогами рейда', exact: true })
    await image.scrollIntoViewIfNeeded()
    await expect(image).toBeVisible()
    const cardBox = (await page.locator('.result-share').boundingBox())!
    const imageBox = (await image.boundingBox())!
    expect(imageBox.y - cardBox.y).toBeLessThanOrEqual(30)
    expect(imageBox.height / imageBox.width).toBeCloseTo(1.25, 1)
    expect(imageBox.height).toBeLessThanOrEqual(526)
    expect((await photo.boundingBox())!.height).toBeLessThanOrEqual(360)
    const layout = await page.locator('.result-shell').evaluate(shell => {
      const children = [...shell.children].map(element => ({ name: element.className, rect: element.getBoundingClientRect() })).filter(item => item.rect.height > 0)
      return { overflow: document.documentElement.scrollWidth - innerWidth,
        gaps: children.slice(1).map((item, index) => item.rect.top - children[index]!.rect.bottom) }
    })
    expect(layout.overflow).toBeLessThanOrEqual(1)
    expect(Math.max(...layout.gaps)).toBeLessThan(48)
    expect(errors).toEqual([])
    await page.screenshot({ path: info.outputPath(`completed-${width}.png`), fullPage: true })
    await info.attach('layout-measurement', { body: JSON.stringify({ width, cardBox, imageBox, ...layout }), contentType: 'application/json' })
  })

  test(`upcoming rows and route covers keep content-sized geometry at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 })
    await prepare(page, true)
    await page.goto(`/app?kabanda=${teamId}&tab=raids`)
    const row = page.locator('.prd-raids .rdp-row').filter({ hasText: base.title })
    await expect(row).toHaveCount(1)
    const rowBox = (await row.boundingBox())!
    expect(rowBox.height).toBeGreaterThanOrEqual(44)
    expect(rowBox.height).toBeLessThan(190)
    const covers = page.locator('.prd-template-card > img')
    await expect(covers).toHaveCount(2)
    for (const cover of await covers.all()) {
      const box = (await cover.boundingBox())!
      expect(box.width).toBeGreaterThan(60)
      expect(box.height / box.width).toBeCloseTo(9 / 16, 1)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: info.outputPath(`upcoming-${width}.png`), fullPage: true })
  })
}
