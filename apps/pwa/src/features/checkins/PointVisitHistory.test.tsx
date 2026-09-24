import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VisitHistoryWindow } from '../results/view-resources'
import { PointVisitHistory, RaidPointVisitHistory } from './PointVisitHistory'

const resourceState = vi.hoisted(() => ({ current: {
  data: null as VisitHistoryWindow | null,
  status: 'loading', message: null as string | null, refreshing: false, refresh: () => Promise.resolve(),
} }))
vi.mock('../results/view-resources', () => ({
  visitHistoryResource: () => ({}), useViewWindow: () => resourceState.current, COMPLETED_REFRESH_MS: 60_000,
}))
vi.mock('../raids/resources', () => ({ useRaidResource: () => resourceState.current }))

const unvisited = { visitedByMe: false, visitedByTeam: false }
const props = { identityId: 'me', kabandaId: 'crew', pointId: 'point' }
beforeEach(() => { resourceState.current = { data: null, status: 'loading', message: null, refreshing: false, refresh: () => Promise.resolve() } })

describe('known point visit presentation', () => {
  it('immediately shows the known raid status while all-time history is still loading', () => {
    const html = renderToStaticMarkup(<PointVisitHistory {...props} currentRaidId="raid" knownVisit={unvisited} />)
    expect(html).toContain('В этом рейде кабанда здесь ещё не была.')
    expect(html).toContain('Уточняем историю…')
    expect(html).not.toContain('point-visit-history__loading')
    expect(html).not.toContain('Ваша кабанда здесь ещё не была.')
  })

  it('does not use a raid projection as an all-time empty history', () => {
    const html = renderToStaticMarkup(<PointVisitHistory {...props} knownVisit={unvisited} />)
    expect(html).toContain('point-visit-history__loading')
    expect(html).not.toContain('здесь ещё не была')
  })

  it('lets a surrounding map status use a quiet loader without assuming empty history', () => {
    const html = renderToStaticMarkup(<PointVisitHistory {...props} compactLoading />)
    expect(html).toContain('Уточняем историю…')
    expect(html).not.toContain('point-visit-history__loading')
    expect(html).not.toContain('здесь ещё не была')
  })

  it('identifies a retained offline projection as the last known state', () => {
    const html = renderToStaticMarkup(<PointVisitHistory {...props} currentRaidId="raid" knownVisit={{ ...unvisited, stale: true }} />)
    expect(html).toContain('По последним данным')
  })

  it('does not display private projected status after access is denied', () => {
    resourceState.current.status = 'access-error'
    resourceState.current.message = 'Access revoked'
    const html = renderToStaticMarkup(<PointVisitHistory {...props} currentRaidId="raid" knownVisit={{ visitedByMe: true, visitedByTeam: true }} />)
    expect(html).not.toContain('Вы уже отмечены')
    expect(html).not.toContain('Уточняем историю…')
    expect(html).toContain('Повторить')
  })

  it('shows returned historical visitors even when this raid has no visit', () => {
    resourceState.current.data = { personalCount: 0, visitors: [{ userId: 'other', displayName: 'Анна', count: 3 }],
      entries: [], nextOffset: null, nextCursor: null, pageCount: 1 }
    resourceState.current.status = 'ready'
    const html = renderToStaticMarkup(<PointVisitHistory {...props} currentRaidId="raid" knownVisit={unvisited} />)
    expect(html).toContain('Анна')
    expect(html).toContain('3 раза')
    expect(html).not.toContain('здесь ещё не была')
    expect(html).not.toContain('Уточняем историю…')
  })

  it('uses the final empty state only once complete history confirms it', () => {
    resourceState.current.data = { personalCount: 0, visitors: [], entries: [], nextOffset: null, nextCursor: null, pageCount: 1 }
    resourceState.current.status = 'ready'
    const html = renderToStaticMarkup(<PointVisitHistory {...props} currentRaidId="raid" knownVisit={unvisited} />)
    expect(html).toContain('Ваша кабанда здесь ещё не была.')
    expect(html).not.toContain('В этом рейде')
  })

  it('keeps a new confirmed visit visible while cached empty history is revalidated', () => {
    resourceState.current.data = { personalCount: 0, visitors: [], entries: [], nextOffset: null, nextCursor: null, pageCount: 1 }
    resourceState.current.status = 'stale'
    resourceState.current.refreshing = true
    const html = renderToStaticMarkup(<PointVisitHistory {...props} currentRaidId="raid" knownVisit={{ visitedByMe: true, visitedByTeam: true }} />)
    expect(html).toContain('Вы уже отмечены здесь в этом рейде.')
    expect(html).toContain('Уточняем историю…')
    expect(html).not.toContain('здесь ещё не была')
  })
})


describe('quiet map summaries', () => {
  it('renders the raid projection without mounting or fetching all-time history', () => {
    const html = renderToStaticMarkup(<RaidPointVisitHistory {...props} currentRaidId="raid" knownVisit={unvisited} />)
    expect(html).toContain('В этом рейде кабанда здесь ещё не была.')
    expect(html).not.toContain('Уточняем историю')
    expect(html).not.toContain('point-visit-history__loading')
    expect(html).toContain('<summary>История посещений</summary>')
  })
  it('uses an explicit all-time zero projection immediately, without a loader', () => {
    const html = renderToStaticMarkup(<PointVisitHistory {...props} knownUnvisited />)
    expect(html).toContain('Ваша кабанда здесь ещё не была.')
    expect(html).not.toContain('point-visit-history__loading')
  })
  it('does not expose the saved empty projection after access revocation', () => {
    resourceState.current.status = 'access-error'
    const html = renderToStaticMarkup(<PointVisitHistory {...props} knownUnvisited />)
    expect(html).not.toContain('здесь ещё не была')
  })
})
