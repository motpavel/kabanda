import { describe, expect, it } from 'vitest'
import {
  filterProductionHistory,
  historyAchievement,
  participationLabel,
  shouldUseProductionCache,
  splitActionableRaids,
} from './production-model'
import { ApiError } from '../../lib/http'
import type { RaidProjection } from './types'
import type { RaidHistoryItem } from '../results/types'

const projection = (overrides: Partial<RaidProjection>): RaidProjection => ({
  id: 'raid-default',
  kabandaId: 'kabanda-1',
  title: 'Рейд',
  state: 'planned',
  version: 1,
  scheduledAt: null,
  description: null,
  organizerUserId: 'owner',
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
  participants: [],
  allowedActions: [],
  ...overrides,
})

const history = (overrides: Partial<RaidHistoryItem>): RaidHistoryItem => ({
  raidId: 'history-default',
  title: 'Завершённый рейд',
  completedAt: '2026-08-31T10:00:00+04:00',
  partial: false,
  team: { durationSeconds: 600, distanceMeters: 2_000, uniquePoints: 3, photos: 1 },
  personal: { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0 },
  ...overrides,
})

describe('production raids adapter model', () => {
  it('fails closed on authoritative client errors instead of exposing cached data', () => {
    expect(shouldUseProductionCache(new ApiError('AUTH_REQUIRED', 'Войдите', 401))).toBe(false)
    expect(shouldUseProductionCache(new ApiError('FORBIDDEN', 'Нет доступа', 403))).toBe(false)
    expect(shouldUseProductionCache(new ApiError('NOT_FOUND', 'Кабанда не найдена', 404))).toBe(false)
    expect(shouldUseProductionCache(new ApiError('SERVER_ERROR', 'Сервис недоступен', 503))).toBe(true)
    expect(shouldUseProductionCache(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('keeps the active raid separate and sorts only canonical actionable raids', () => {
    const active = projection({ id: 'active', state: 'active' })
    const later = projection({ id: 'later', title: 'Позже', scheduledAt: '2026-09-03T10:00:00+04:00' })
    const sooner = projection({ id: 'sooner', title: 'Раньше', scheduledAt: '2026-09-02T10:00:00+04:00' })

    expect(splitActionableRaids([later, active, sooner], 'owner')).toEqual({
      current: active,
      upcoming: [sooner, later],
    })
  })

  it('hides upcoming raids until the signed-in identity has joined or organizes them', () => {
    const invited = projection({
      id: 'invited',
      organizerUserId: 'another-owner',
      participants: [{ id: 'viewer', displayName: 'Павел', avatarUrl: null, state: 'invited' }],
    })
    const accepted = projection({
      id: 'accepted',
      organizerUserId: 'another-owner',
      participants: [{ id: 'viewer', displayName: 'Павел', avatarUrl: null, state: 'accepted' }],
    })
    const organized = projection({ id: 'organized', organizerUserId: 'viewer', participants: [] })

    expect(splitActionableRaids([invited], 'viewer').upcoming).toEqual([])
    expect(splitActionableRaids([invited, accepted, organized], 'viewer').upcoming)
      .toEqual([accepted, organized])
  })

  it('does not invent personal history when canonical personal metrics are empty', () => {
    const teamOnly = history({ raidId: 'team-only' })
    const mine = history({
      raidId: 'mine',
      personal: { durationSeconds: 120, distanceMeters: 800, uniquePoints: 1, photos: 0 },
    })

    expect(filterProductionHistory([teamOnly, mine], 'mine')).toEqual([mine])
    expect(historyAchievement(teamOnly)).toEqual({ label: 'Итог Кабанды', tone: 'discovery' })
    expect(historyAchievement(mine)).toEqual({ label: 'Вы участвовали', tone: 'record' })
  })

  it('derives the upcoming badge from the signed-in participant state', () => {
    const raid = projection({
      organizerUserId: 'owner',
      participants: [{ id: 'member', displayName: 'Мотор', avatarUrl: null, state: 'ready' }],
    })

    expect(participationLabel(raid, 'owner')).toBe('Вы организатор')
    expect(participationLabel(raid, 'member')).toBe('Вы готовы')
  })
})
