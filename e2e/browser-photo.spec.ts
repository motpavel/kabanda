import { expect, test } from '@playwright/test'
import { installYandexMapsMock } from './support.js'
import type { RaidProjection } from '../apps/pwa/src/features/raids/types.js'

const userId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const raidId = '33333333-3333-4333-8333-333333333333'
const pointId = '44444444-4444-4444-8444-444444444444'
const raid: RaidProjection = { id: raidId, kabandaId: teamId, title: 'Подготовка фото', state: 'active', version: 1,
  scheduledAt: null, description: null, organizerUserId: userId, navigatorUserId: '55555555-5555-4555-8555-555555555555',
  navigatorReady: true, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  participants: [{ id: userId, displayName: 'Участник', avatarUrl: null, state: 'active' }], allowedActions: [],
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null } }

test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' })
test('selected PNG reaches the durable photo queue through the real browser decoder', async ({ page, context }, info) => {
  await installYandexMapsMock(context)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.addInitScript(() => {
    const diagnostic: string[] = []
    Object.assign(window, { photoPreparationSteps: diagnostic })
    if (typeof window.createImageBitmap === 'function') {
      const bitmap = window.createImageBitmap.bind(window)
      window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
        diagnostic.push('decode:start')
        return bitmap(...args).then(value => { diagnostic.push('decode:ok'); return value }, error => {
          diagnostic.push(`decode:${error.name}:${error.message}`); throw error
        })
      }) as typeof createImageBitmap
    } else diagnostic.push('decode:unavailable')
    const encode = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      diagnostic.push('encode:start')
      return encode.call(this, value => { diagnostic.push(value ? 'encode:ok' : 'encode:empty'); callback(value) }, type, quality)
    }
  })
  const photo = { pointSnapshotId: pointId, sourcePointId: pointId, name: 'Остановка', latitude: 56.86, longitude: 53.21,
    distanceMeters: 0, creditedByMe: false, creditedByTeam: false }
  let uploadRequests = 0
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/materials') && route.request().method() === 'POST') {
      uploadRequests++
      return route.fulfill({ status: 503, json: { error: { code: 'TEST_PHOTO', message: 'Synthetic upload pause' } } })
    }
    const body = path === '/api/me' ? { user: { id: userId, displayName: 'Участник', username: 'photo-qa', email: 'photo@example.test', identityKind: 'verified', avatarUrl: null } }
      : path === '/api/kabandas' ? { kabandas: [{ id: teamId, name: 'Фото', role: 'member', avatar: '🐗', coverImage: null, memberCount: 1, pointsCollectionId: null }] }
      : path.endsWith('/live') ? { raid, teamVisits: true, revision: '1', serverAt: new Date().toISOString(), claims: [], fallbacks: [], positions: [],
        points: [{ id: pointId, sourcePointId: pointId, name: 'Остановка', latitude: 56.86, longitude: 53.21, position: 0, visitedByMe: false, visitedByTeam: false }] }
      : path.endsWith('/materials') ? { materials: [], nextCursor: null }
      : path.endsWith(`/points/${pointId}/history`) ? { pointId, personalCount: 0, visitors: [], entries: [], nextOffset: null }
      : path.endsWith('/check-ins/nearby') ? { policy: { version: 'v1', radiusMeters: 50, maxAgeSeconds: 60, maxAccuracyMeters: 50 }, points: [photo] }
      : path.endsWith('/check-ins/presence') ? { pointSnapshotId: pointId, radiusMeters: 50, participants: [], serverAt: new Date().toISOString() }
      : path.endsWith('/presence/me') ? { radiusMeters: 50, maxAgeSeconds: 30, allReady: false, participants: [], serverAt: new Date().toISOString() }
      : path.endsWith('/raids') ? { raids: [raid] }
      : path.includes('templates') ? { templates: [], nextCursor: null }
      : path === `/api/raids/${raidId}` ? { raid } : {}
    return route.fulfill({ json: body })
  })
  await page.goto(`/app?raid=${raidId}`)
  await page.getByRole('button', { name: /^Остановка\./ }).click()
  const panel = page.getByRole('region', { name: 'Фото и комментарии точки' })
  try {
    await expect(panel).toBeVisible()
    await panel.locator('input[type="file"]').setInputFiles('apps/pwa/public/pwa-192x192.png')
    await expect.poll(async () => {
      if (uploadRequests > 0) return 'durably saved'
      return page.evaluate(() => JSON.stringify({ steps: (window as any).photoPreparationSteps,
        message: document.querySelector('.point-materials [role="status"]')?.textContent ?? null }))
    }, { timeout: 15000 }).toBe('durably saved')
    expect(errors).toEqual([])
  } finally {
    await info.attach('photo-preparation-steps', { body: JSON.stringify({ errors, browser: await page.evaluate(() => ({
      steps: (window as any).photoPreparationSteps, message: document.querySelector('.point-materials [role="status"]')?.textContent ?? null,
    })) }), contentType: 'application/json' })
  }
})
