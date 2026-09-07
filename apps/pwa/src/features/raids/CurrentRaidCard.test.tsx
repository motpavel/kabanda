import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CurrentRaidCard, currentRaidPresentation } from './CurrentRaidCard'
import type { KabandaSummary } from '../kabandas/types'
import type { RaidProjection } from './types'

const kabanda: KabandaSummary = { id: 'crew', name: 'Наша Кабанда', avatar: '🐗', coverImage: null, role: 'member', memberCount: 5, pointsCollectionId: null }
const raid: RaidProjection = {
  id: 'ride', kabandaId: 'crew', title: 'Свободный рейд · 6 сентября', state: 'active', version: 3,
  scheduledAt: null, startedAt: '2026-09-06T08:30:00Z', description: null,
  organizerUserId: 'rider-1', navigatorUserId: 'rider-1', navigatorReady: false,
  navigatorBlockers: [], navigatorWarnings: [], finalization: null, navigatorLease: null,
  routeStatus: { status: 'fresh', lastSampleAt: null, lastReceivedAt: null, acceptedSampleCount: 91, missingSequenceCount: 0 },
  participants: [{ id: 'rider-1', displayName: 'Павел', state: 'active', avatarUrl: null }], allowedActions: [],
}

describe('shared current raid card', () => {
  it('uses the existing artwork and truthful metrics with readable semantic labels', () => {
    const html = renderToStaticMarkup(<CurrentRaidCard kabanda={kabanda} raid={raid} stale={false} onRefresh={() => undefined} />)
    expect(html).toContain('data-testid="current-raid-card"')
    expect(html).toContain('Свободная охота</h3>')
    expect(html).toContain('dateTime="2026-09-06T08:30:00Z">6 сентября</time>')
    expect(html).toContain('<dt>участник</dt><dd>1</dd>')
    expect(html).toContain('<dt>точек трека</dt><dd>91</dd>')
    expect(html).toContain('<dt>навигатор</dt><dd>Назначен</dd>')
    expect(html).toContain('href="/app?raid=ride"')
    expect(html).not.toContain('без времени')
    expect(html).not.toContain('Старт после сбора')
    expect(html).not.toContain('1 участников')
  })

  it('preserves custom titles and never treats a route as an auto-named hunt', () => {
    expect(currentRaidPresentation({ ...raid, title: 'Вылазка в центр · 6 сентября' }).title).toBe('Вылазка в центр · 6 сентября')
    expect(currentRaidPresentation({ ...raid, routeTemplateId: 'route' }).title).toBe(raid.title)
    expect(currentRaidPresentation(raid).title).toBe('Свободная охота')
    expect(raid.title).toBe('Свободный рейд · 6 сентября')
  })

  it('supports older cached projections without inventing an actual start time', () => {
    const old = currentRaidPresentation({ ...raid, startedAt: undefined })
    expect(old).toMatchObject({ title: 'Свободная охота', date: '6 сентября', dateTime: null, startTime: '—' })
    expect(currentRaidPresentation({ ...raid, title: 'Вечерняя прогулка', startedAt: null }).date).toBeNull()
  })

  it('keeps a stale projection behind the refresh action', () => {
    const html = renderToStaticMarkup(<CurrentRaidCard kabanda={kabanda} raid={raid} stale onRefresh={() => undefined} />)
    expect(html).not.toContain('href="/app?raid=ride"')
    expect(html).toContain('<button')
  })

  it('counts only confirmed participants and uses Russian plural forms', () => {
    const participants = Array.from({ length: 5 }, (_, i) => ({ id: `rider-${i}`, displayName: 'Участник', state: 'active' as const, avatarUrl: null }))
    const html = renderToStaticMarkup(<CurrentRaidCard kabanda={kabanda} raid={{ ...raid, participants: [...participants, { id: 'invited', displayName: 'Приглашён', state: 'invited', avatarUrl: null }] }} stale={false} onRefresh={() => undefined} />)
    expect(html).toContain('<dt>участников</dt><dd>5</dd>')
  })
})
