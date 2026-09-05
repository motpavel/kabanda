import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { KabandaSummary } from '../kabandas/types'
import { HomeDashboard } from './HomeDashboard'

const kabanda: KabandaSummary = { id: 'team-one', name: 'Вечерняя Кабанда', avatar: '🐗', coverImage: null, role: 'member', memberCount: 5, pointsCollectionId: null }

describe('home dashboard', () => {
  it('links the existing destinations without inventing results or upcoming rides', () => {
    const html = renderToStaticMarkup(<HomeDashboard identityId="me" kabanda={kabanda} members={[]} progress={null} />)
    for (const tab of ['kabanda', 'map', 'raids']) expect(html).toContain(`href="/app?kabanda=team-one&amp;tab=${tab}"`)
    expect(html).toContain('5 участников')
    expect(html).toContain('Вы участник')
    expect(html).toContain('<dd>—</dd>')
    expect(html).not.toContain('<dd>0</dd>')
    expect(html).not.toContain('Создать рейд') // Loading is not an authoritative empty state.
  })

  it('renders personal server metrics, not team totals', () => {
    const html = renderToStaticMarkup(<HomeDashboard identityId="me" kabanda={kabanda} members={[]} progress={{
      personal: { completedRaids: 3, distanceMeters: 12500, photos: 7, durationSeconds: 600, uniquePoints: 8 },
      team: { completedRaids: 20, distanceMeters: 200000, photos: 100, durationSeconds: 9000, uniquePoints: 50 },
    }} />)
    expect(html).toContain('<dd>3</dd>')
    expect(html).toContain('<dd>12,5</dd>')
    expect(html).toContain('<dd>7</dd>')
    expect(html).not.toContain('<dd>20</dd>')
  })

  it('escapes team names and shows actual roster without made-up online states', () => {
    const html = renderToStaticMarkup(<HomeDashboard identityId="me" kabanda={{ ...kabanda, name: '<script>test</script>', role: 'owner' }} progress={null} members={[{ id: 'me', displayName: 'Павел', role: 'owner', avatarUrl: null }]} />)
    expect(html).toContain('&lt;script&gt;test&lt;/script&gt;')
    expect(html).toContain('1 участник')
    expect(html).toContain('Вы вожак')
    expect(html).toContain('aria-label="Павел"')
    expect(html).not.toContain('В сети')
  })
})
