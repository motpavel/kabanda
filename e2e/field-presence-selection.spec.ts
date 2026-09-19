import { expect, test } from '@playwright/test'
import { installYandexMapsMock } from './support.js'
import type { RaidProjection } from '../apps/pwa/src/features/raids/types.js'

const navigatorId = '11111111-1111-4111-8111-111111111111'
const firstId = '22222222-2222-4222-8222-222222222222'
const secondId = '33333333-3333-4333-8333-333333333333'
const raidId = '44444444-4444-4444-8444-444444444444'
const teamId = '55555555-5555-4555-8555-555555555555'
const pointId = '66666666-6666-4666-8666-666666666666'
const coordinate = { latitude: 56.86, longitude: 53.21, accuracy: 8 }
const members = [{ id: navigatorId, displayName: 'Навигатор' }, { id: firstId, displayName: 'Первый участник' }, { id: secondId, displayName: 'Второй участник' }]
const raid: RaidProjection = {
  id: raidId, kabandaId: teamId, title: 'Проверка списка на остановке', state: 'active', version: 3,
  scheduledAt: null, description: null, organizerUserId: navigatorId, navigatorUserId: navigatorId,
  navigatorReady: true, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  participants: members.map(member => ({ ...member, avatarUrl: null, state: 'active' })), allowedActions: [],
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null },
}

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block',
  permissions: ['geolocation'], geolocation: coordinate })

test('presence oscillation does not uncheck attendees or undo explicit exclusion', async ({ page, context }) => {
  await installYandexMapsMock(context)
  let nearby = new Set([navigatorId, firstId]), presenceReads = 0, checkinWrites = 0
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname, serverAt = new Date().toISOString()
    const point = { pointSnapshotId: pointId, sourcePointId: pointId, name: 'Остановка', ...coordinate,
      distanceMeters: 0, creditedByMe: false, creditedByTeam: false }
    if (path.endsWith('/check-ins/presence')) {
      presenceReads++
      return route.fulfill({ json: { pointSnapshotId: pointId, radiusMeters: 50, serverAt,
        participants: members.map(member => ({ id: member.id, status: nearby.has(member.id) ? 'nearby' : 'waiting', observedAt: nearby.has(member.id) ? serverAt : null })) } })
    }
    if (path.endsWith('/check-ins') && route.request().method() === 'POST') checkinWrites++
    if (path.includes('/route/lease/')) return route.fulfill({ status: 409,
      json: { error: { code: 'NAVIGATOR_LEASE_HELD', message: 'Synthetic recording device' } } })
    const body = path === '/api/me' ? { user: { id: navigatorId, displayName: 'Навигатор', username: 'navigator', email: 'navigator@example.test', identityKind: 'verified', avatarUrl: null } }
      : path === '/api/kabandas' ? { kabandas: [{ id: teamId, name: 'Проверка присутствия', role: 'member', avatar: '🐗', coverImage: null, memberCount: 3, pointsCollectionId: null }] }
      : path.endsWith('/live') ? { raid, claims: [], fallbacks: [],
        points: [{ id: pointId, sourcePointId: pointId, name: 'Остановка', ...coordinate, position: 0, visitedByMe: false, visitedByTeam: false }],
        track: { segments: [], pointCount: 0, truncated: false, updatedAt: null, serverAt } }
      : path.endsWith('/check-ins/nearby') ? { policy: { version: 'v1', radiusMeters: 50, maxAgeSeconds: 60, maxAccuracyMeters: 50 }, points: [point] }
      : path.endsWith('/presence/me') ? { radiusMeters: 50, maxAgeSeconds: 30, allReady: false, participants: [], serverAt }
      : path.endsWith('/media') ? { media: [], nextCursor: null }
      : path.endsWith('/raids') ? { raids: [raid] }
      : path.includes('templates') ? { templates: [], nextCursor: null }
      : path.endsWith('/members') ? { members: members.map(member => ({ ...member, role: 'member', avatarUrl: null })) }
      : path === `/api/raids/${raidId}` ? { raid } : {}
    return route.fulfill({ json: body })
  })
  await page.goto(`/app?raid=${raidId}`)
  const first = page.getByRole('checkbox', { name: 'Первый участник', exact: true })
  const second = page.getByRole('checkbox', { name: 'Второй участник', exact: true })
  await expect(first).toBeChecked({ timeout: 15_000 })
  await expect(second).not.toBeChecked()
  const initialReads = presenceReads
  nearby = new Set([navigatorId, secondId])
  await expect(second).toBeChecked({ timeout: 15_000 })
  expect(presenceReads).toBeGreaterThan(initialReads)
  await expect(first).toBeChecked()
  await expect(page.getByRole('checkbox', { name: /Все выбранные участники здесь/ })).not.toBeChecked()
  await first.uncheck()
  const beforeReturn = presenceReads
  nearby = new Set([navigatorId, firstId, secondId])
  await expect.poll(() => presenceReads, { timeout: 15_000 }).toBeGreaterThan(beforeReturn)
  await expect(first).not.toBeChecked()
  await expect(second).toBeChecked()
  expect(checkinWrites).toBe(0)
  expect(errors).toEqual([])
})
