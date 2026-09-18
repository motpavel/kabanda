import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { HomeDashboard } from './HomeDashboard'
import { actionableResource, resetRaidResources } from '../raids/resources'
import type { RaidProjection } from '../raids/types'
import type { KabandaSummary } from '../kabandas/types'
import type { RaidResult } from '../results/types'
import { RaidCompletionHero } from '../results/RaidCompletionHero'
import { selectCatalogRoutes } from '../raid-plans/catalog-selection'

const crew: KabandaSummary = { id: 'crew', name: 'Кабанда', role: 'member', avatar: '🐗', coverImage: null, memberCount: 1, pointsCollectionId: null }
const raid: RaidProjection = {
  id: 'ride', kabandaId: 'crew', title: 'Текущая поездка', state: 'active', version: 2,
  scheduledAt: null, description: null, organizerUserId: 'me', navigatorUserId: 'me',
  navigatorReady: true, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null },
  participants: [{ id: 'me', displayName: 'Я', avatarUrl: null, state: 'active' }], allowedActions: [],
}
afterEach(() => resetRaidResources())

describe('home priority and compact catalog', () => {
  it.each(['active', 'paused', 'finalizing'] as const)('places a %s ride before the hero exactly once', state => {
    actionableResource('me', crew.id, 'member').accept([{ ...raid, state }], false)
    const html = renderToStaticMarkup(<HomeDashboard identityId="me" kabanda={crew} members={[]} progress={null} />)
    expect(html.indexOf('raid-home-current')).toBeGreaterThan(-1)
    expect(html.indexOf('raid-home-current')).toBeLessThan(html.indexOf('kb-home-hero'))
    expect(html.match(/class="raid-home-current"/g)).toHaveLength(1)
  })

  it('does not invent an ongoing ride from loading or a confirmed empty list', () => {
    for (const loaded of [false, true]) {
      resetRaidResources()
      if (loaded) actionableResource('me', crew.id, 'member').accept([], false)
      const html = renderToStaticMarkup(<HomeDashboard identityId="me" kabanda={crew} members={[]} progress={null} />)
      expect(html).not.toContain('kb-home--in-raid')
      expect(html).not.toContain('raid-home-current')
    }
  })

  it('shows four newest routes and preserves the source and remaining routes', () => {
    const source = Array.from({ length: 7 }, (_, index) => ({ id: String(index), createdAt: `2026-09-${String(index + 1).padStart(2, '0')}T12:00:00Z` }))
    const before = JSON.stringify(source)
    expect(selectCatalogRoutes(source).map(row => row.id)).toEqual(['6', '5', '4', '3'])
    expect(selectCatalogRoutes(source, true)).toHaveLength(7)
    expect(JSON.stringify(source)).toBe(before)
    expect(selectCatalogRoutes([])).toEqual([])
  })
})

describe('completion hero', () => {
  it('reserves four metric positions without claiming zero before the result arrives', () => {
    const html = renderToStaticMarkup(<RaidCompletionHero result={null} />)
    expect(html).toContain('aria-busy="true"')
    expect(html.match(/Данные ещё не получены/g)).toHaveLength(4)
    expect(html).not.toContain('>0<')
  })

  it('renders confirmed results in the same four positions', () => {
    const metrics = { durationSeconds: 600, distanceMeters: 1500, uniquePoints: 2, photos: 0 }
    const result: RaidResult = { schemaVersion: 1, raid: { id: 'ride', kabandaId: 'crew', title: 'Текущая поездка', startedAt: '2026-09-18T12:00:00Z', completedAt: '2026-09-18T12:10:00Z', partial: false }, team: metrics, personal: metrics, participants: [] }
    const html = renderToStaticMarkup(<RaidCompletionHero result={result} />)
    expect(html).toContain('aria-busy="false"')
    expect(html).toContain('00:10:00')
    expect(html).toContain('1,5')
    expect(html).not.toContain('Данные ещё не получены')
    expect(html.match(/<dd/g)).toHaveLength(4)
  })
})
