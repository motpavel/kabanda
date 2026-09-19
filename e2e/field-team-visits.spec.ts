import { expect, test, type Page } from '@playwright/test'
import { installYandexMapsMock } from './support.js'
import type { RaidProjection } from '../apps/pwa/src/features/raids/types.js'

const teamId = '22222222-2222-4222-8222-222222222222'
const raidId = '33333333-3333-4333-8333-333333333333'
const pointId = '44444444-4444-4444-8444-444444444444'
const sourcePointId = '55555555-5555-4555-8555-555555555555'
const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '66666666-6666-4666-8666-666666666666'
const navigatorId = '77777777-7777-4777-8777-777777777777'
const members = [firstId, secondId, navigatorId].map((id, index) => ({
  id, displayName: `Участник ${index + 1}`, avatarUrl: null, state: 'active' as const,
}))
const raid: RaidProjection = {
  id: raidId, kabandaId: teamId, title: 'Проверка командной остановки', state: 'active', version: 3,
  scheduledAt: null, description: null, organizerUserId: navigatorId, navigatorUserId: navigatorId,
  navigatorReady: true, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  participants: members, allowedActions: [],
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null },
}

test('one confirmed team visit updates both open maps without inventing the other participant credit', async ({ browser }) => {
  const contexts = await Promise.all([firstId, secondId].map(() => browser.newContext({
    viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block',
    permissions: ['geolocation'], geolocation: { latitude: 56.85, longitude: 53.21, accuracy: 8 },
  })))
  let confirmed = false, secondUnavailable = false
  const liveRequests = new Map<string, number>()
  const errors: string[] = []
  const pages: Page[] = []
  try {
    for (const [index, context] of contexts.entries()) {
      await installYandexMapsMock(context)
      const identityId = index === 0 ? firstId : secondId
      const page = await context.newPage()
      pages.push(page)
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url()), path = url.pathname
        const now = new Date().toISOString()
        if (path.endsWith('/live')) {
          liveRequests.set(identityId, (liveRequests.get(identityId) ?? 0) + 1)
          if (identityId === secondId && secondUnavailable) return route.fulfill({ status: 503,
            json: { error: { code: 'TEST_OUTAGE', message: 'Temporary read failure' } } })
          return route.fulfill({ json: {
            raid,
            track: { segments: [], pointCount: 0, truncated: false, updatedAt: null, serverAt: now },
            points: [{ id: pointId, sourcePointId, name: 'Командная остановка', latitude: 56.86, longitude: 53.21,
              position: 0, visitedByMe: confirmed && identityId === firstId, visitedByTeam: confirmed }],
            claims: [], fallbacks: [],
          } })
        }
        const body = path === '/api/me' ? { user: { id: identityId, displayName: 'Участник', username: `rider${index}`, email: `rider${index}@example.test`, identityKind: 'verified', avatarUrl: null } }
          : path === '/api/kabandas' ? { kabandas: [{ id: teamId, name: 'Полевая проверка', role: 'member', avatar: '🐗', coverImage: null, memberCount: 3, pointsCollectionId: null }] }
          : path.endsWith('/raids/history/page') ? { schemaVersion: 2, scope: url.searchParams.get('scope') ?? 'all', raids: [], nextCursor: null }
          : path.endsWith('/raids') ? { raids: [raid] }
          : path.includes('templates') ? { templates: [], nextCursor: null }
          : path.endsWith('/members') ? { members: members.map(member => ({ ...member, role: 'member' })) }
          : path.endsWith('/check-ins/nearby') ? { policy: { version: 'v1', radiusMeters: 50, maxAgeSeconds: 60, maxAccuracyMeters: 50 }, points: [] }
          : path.endsWith('/presence/me') ? { radiusMeters: 50, maxAgeSeconds: 30, allReady: false, participants: [], serverAt: now }
          : path.endsWith('/media') ? { media: [], nextCursor: null }
          : path.endsWith('/progress') ? { progress: { personal: { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0, completedRaids: 0 }, team: { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0, completedRaids: 0 } } }
          : path === `/api/raids/${raidId}` ? { raid } : {}
        return route.fulfill({ json: body })
      })
      await page.goto(`/app?raid=${raidId}`)
    }
    const firstPin = pages[0]!.getByRole('button', { name: /Командная остановка/ })
    const secondPin = pages[1]!.getByRole('button', { name: /Командная остановка/ })
    await expect(firstPin).toHaveCount(1)
    await expect(secondPin).toHaveCount(1)
    await expect(firstPin).not.toHaveClass(/raid-live-point--visited/)
    await expect(secondPin).not.toHaveClass(/raid-live-point--visited/)
    // Simulate the server having committed a visit, not a local pending attempt.
    // Deliberately leave raid.version and track metadata unchanged: a point
    // credit is not necessarily a lifecycle transition or a route update.
    confirmed = true
    await expect(firstPin).toHaveClass(/raid-live-point--visited/, { timeout: 15_000 })
    await expect(secondPin).toHaveClass(/raid-live-point--visited/, { timeout: 15_000 })
    await expect(firstPin).toHaveAttribute('aria-label', /Вы уже были/)
    await expect(secondPin).toHaveAttribute('aria-label', /Кабанда уже была/)
    await expect(secondPin).not.toHaveAttribute('aria-label', /Вы уже были/)
    const beforeOutage = liveRequests.get(secondId) ?? 0
    secondUnavailable = true
    await expect.poll(() => liveRequests.get(secondId) ?? 0, { timeout: 15_000 }).toBeGreaterThan(beforeOutage)
    await expect(secondPin).toHaveClass(/raid-live-point--visited/)
    await expect(pages[1]!.locator('.raid-active-map')).toHaveCount(1)
    expect(errors).toEqual([])
  } finally {
    await Promise.all(contexts.map(context => context.close()))
  }
})
