import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { KabandaSummary } from '../kabandas/types'
import { InvitationRaidRow, ProductionCreateRaidAction, ProductionRaidsHub } from './ProductionRaidsHub'
import type { RaidProjection } from './types'

const kabanda: KabandaSummary = {
  id: 'kabanda-real-id',
  name: 'Тестовая Кабанда',
  avatar: '🐗',
  coverImage: null,
  role: 'owner',
  memberCount: 2,
  pointsCollectionId: null,
}

describe('ProductionRaidsHub shell', () => {
  it('starts in an explicit loading state without exposing a create mutation', () => {
    const markup = renderToStaticMarkup(<ProductionRaidsHub identityId="owner-id" kabanda={kabanda} />)

    expect(markup).toContain('data-testid="production-raids-hub"')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).not.toContain('data-testid="production-new-raid"')
    expect(markup).not.toContain('Северное кольцо')
    expect(markup).not.toContain('Центр на закате')
  })

  it('offers the canonical create action to any member only when mutations are enabled', () => {
    const markup = renderToStaticMarkup(
      <ProductionCreateRaidAction enabled kabandaId={kabanda.id} />,
    )

    expect(markup).toContain('data-testid="production-new-raid"')
    expect(markup).toContain('href="/app?createRaid=kabanda-real-id"')
    expect(renderToStaticMarkup(<ProductionCreateRaidAction enabled={false} kabandaId={kabanda.id} />)).toBe('')
  })

  it('renders a canonical invitation with accessible accept and decline actions', () => {
    const raid: RaidProjection = {
      id: 'raid-invited',
      kabandaId: kabanda.id,
      title: 'Вечерний рейд',
      state: 'lobby',
      version: 4,
      scheduledAt: '2026-09-02T19:00:00+04:00',
      description: 'По набережной',
      organizerUserId: 'owner-id',
      navigatorUserId: null,
      navigatorReady: false,
      navigatorBlockers: [],
      navigatorWarnings: [],
      routeStatus: {
        status: 'awaiting_lease',
        lastSampleAt: null,
        lastReceivedAt: null,
        acceptedSampleCount: 0,
        missingSequenceCount: 0,
      },
      navigatorLease: null,
      finalization: null,
      participants: [{ id: 'member-id', displayName: 'Мотор', avatarUrl: null, state: 'invited' }],
      allowedActions: ['accept', 'decline'],
    }

    const markup = renderToStaticMarkup(
      <InvitationRaidRow
        busyCommand={null}
        disabled={false}
        onRespond={() => undefined}
        raid={raid}
      />,
    )

    expect(markup).toContain('Вечерний рейд')
    expect(markup).toContain('href="/app?raid=raid-invited"')
    expect(markup).toContain('Принять')
    expect(markup).toContain('Отказаться')
    expect(markup).not.toContain('disabled=""')
  })

  it('disables invitation mutations for an offline or stale projection', () => {
    const raid = {
      id: 'raid-invited', kabandaId: kabanda.id, title: 'Рейд', state: 'lobby', version: 1,
      scheduledAt: null, description: null, organizerUserId: 'owner-id', navigatorUserId: null,
      navigatorReady: false, navigatorBlockers: [], navigatorWarnings: [],
      routeStatus: { status: 'awaiting_lease', lastSampleAt: null, lastReceivedAt: null, acceptedSampleCount: 0, missingSequenceCount: 0 },
      navigatorLease: null, finalization: null, participants: [], allowedActions: ['accept', 'decline'],
    } satisfies RaidProjection

    const markup = renderToStaticMarkup(
      <InvitationRaidRow busyCommand={null} disabled onRespond={() => undefined} raid={raid} />,
    )

    expect(markup.match(/disabled=""/g)).toHaveLength(2)
  })
})
