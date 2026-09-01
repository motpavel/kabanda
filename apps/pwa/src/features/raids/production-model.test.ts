import { describe, expect, it } from 'vitest'
import {
  confirmedRaidParticipants,
  filterProductionHistory,
  findRaidCreationMembership,
  historyAchievement,
  participationLabel,
  productionResourcePolicy,
  ProductionRefreshFence,
  selectIdentityCurrentRaid,
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
  it('renders stale cache read-only but never turns failures into empty or create states', () => {
    expect(productionResourcePolicy('ready', true)).toEqual({ renderContent: true, canMutate: true })
    expect(productionResourcePolicy('ready', false)).toEqual({ renderContent: true, canMutate: false })
    expect(productionResourcePolicy('stale', true)).toEqual({ renderContent: true, canMutate: false })
    expect(productionResourcePolicy('access-error', true)).toEqual({ renderContent: false, canMutate: false })
    expect(productionResourcePolicy('error', true)).toEqual({ renderContent: false, canMutate: false })
    expect(productionResourcePolicy('loading', true)).toEqual({ renderContent: false, canMutate: false })
  })

  it('selects a current raid only for its organizer or an active participant', () => {
    const unrelated = projection({ id: 'unrelated', state: 'active', organizerUserId: 'another' })
    const invitedActive = projection({
      id: 'invited-active',
      state: 'active',
      organizerUserId: 'another',
      participants: [{ id: 'viewer', displayName: 'Павел', avatarUrl: null, state: 'invited' }],
    })
    const declinedActive = projection({
      id: 'declined-active',
      state: 'active',
      organizerUserId: 'another',
      participants: [{ id: 'viewer', displayName: 'Павел', avatarUrl: null, state: 'declined' }],
    })
    const participating = projection({
      id: 'participating',
      state: 'paused',
      organizerUserId: 'another',
      participants: [{ id: 'viewer', displayName: 'Павел', avatarUrl: null, state: 'active' }],
    })

    expect(selectIdentityCurrentRaid([unrelated, invitedActive, declinedActive], 'viewer')).toBeNull()
    expect(selectIdentityCurrentRaid([unrelated], 'another')).toBe(unrelated)
    expect(selectIdentityCurrentRaid([unrelated, invitedActive, declinedActive, participating], 'viewer')).toBe(participating)
  })

  it('fences a deferred poll that started before a participant mutation', async () => {
    let resolvePoll!: (raid: RaidProjection) => void
    const deferredPoll = new Promise<RaidProjection>((resolve) => { resolvePoll = resolve })
    const fence = new ProductionRefreshFence()
    const stale = projection({ id: 'raid', version: 1 })
    const accepted = projection({
      id: 'raid',
      version: 2,
      participants: [{ id: 'viewer', displayName: 'Павел', avatarUrl: null, state: 'accepted' }],
    })
    let visible = stale

    const poll = (async () => {
      const token = fence.beginRefresh()
      expect(token).not.toBeNull()
      const response = await deferredPoll
      if (token !== null && fence.canApplyRefresh(token)) visible = response
    })()

    expect(fence.beginMutation()).toBe(true)
    expect(fence.beginRefresh()).toBeNull()
    visible = accepted
    fence.finishMutation()
    expect(fence.beginRefresh()).toBe(1)
    resolvePoll(stale)
    await poll

    expect(visible).toBe(accepted)
    expect(visible.version).toBe(2)
  })

  it('allows raid creation for any active Kabanda membership', () => {
    const owner = { id: 'owner-team', name: 'Owner team', avatar: '🐗', coverImage: null, role: 'owner', memberCount: 2, pointsCollectionId: null } as const
    const member = { ...owner, id: 'member-team', name: 'Member team', role: 'member' } as const

    expect(findRaidCreationMembership([owner, member], owner.id)).toBe(owner)
    expect(findRaidCreationMembership([owner, member], member.id)).toBe(member)
    expect(findRaidCreationMembership([owner, member], 'unknown')).toBeNull()
  })

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
      invitations: [],
      upcoming: [sooner, later],
    })
  })

  it('separates invitations until the signed-in identity accepts or organizes the raid', () => {
    const invited = projection({
      id: 'invited',
      state: 'lobby',
      organizerUserId: 'another-owner',
      participants: [{ id: 'viewer', displayName: 'Павел', avatarUrl: null, state: 'invited' }],
    })
    const accepted = projection({
      id: 'accepted',
      organizerUserId: 'another-owner',
      participants: [{ id: 'viewer', displayName: 'Павел', avatarUrl: null, state: 'accepted' }],
    })
    const organized = projection({ id: 'organized', organizerUserId: 'viewer', participants: [] })

    expect(splitActionableRaids([invited], 'viewer')).toEqual({
      current: null,
      invitations: [invited],
      upcoming: [],
    })
    expect(splitActionableRaids([invited, accepted, organized], 'viewer')).toEqual({
      current: null,
      invitations: [invited],
      upcoming: [accepted, organized],
    })
  })

  it('shows an invitation only while its raid has an open lobby', () => {
    const invitedActive = projection({
      id: 'invited-active',
      state: 'active',
      organizerUserId: 'another-owner',
      participants: [{ id: 'viewer', displayName: 'Павел', avatarUrl: null, state: 'invited' }],
    })

    expect(splitActionableRaids([invitedActive], 'viewer')).toEqual({
      current: null,
      invitations: [],
      upcoming: [],
    })
  })

  it('keeps declined and removed invitations out of both visible queues', () => {
    const declined = projection({
      id: 'declined',
      organizerUserId: 'another-owner',
      participants: [{ id: 'viewer', displayName: 'Павел', avatarUrl: null, state: 'declined' }],
    })
    const removed = projection({
      id: 'removed',
      organizerUserId: 'another-owner',
      participants: [{ id: 'viewer', displayName: 'Павел', avatarUrl: null, state: 'removed' }],
    })

    expect(splitActionableRaids([declined, removed], 'viewer')).toEqual({
      current: null,
      invitations: [],
      upcoming: [],
    })
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
      participants: [
        { id: 'owner', displayName: 'Вожак', avatarUrl: null, state: 'accepted' },
        { id: 'member', displayName: 'Мотор', avatarUrl: null, state: 'ready' },
      ],
    })

    expect(participationLabel(raid, 'owner')).toBe('Вы организатор')
    expect(participationLabel(raid, 'member')).toBe('Вы готовы')
  })

  it('counts and exposes avatars only for people who confirmed participation', () => {
    const raid = projection({
      organizerUserId: 'owner',
      participants: [
        { id: 'owner', displayName: 'Вожак', avatarUrl: null, state: 'accepted' },
        { id: 'ready', displayName: 'Готов', avatarUrl: null, state: 'ready' },
        { id: 'active', displayName: 'В пути', avatarUrl: null, state: 'active' },
        { id: 'invited', displayName: 'Приглашён', avatarUrl: null, state: 'invited' },
        { id: 'declined', displayName: 'Отказался', avatarUrl: null, state: 'declined' },
        { id: 'removed', displayName: 'Удалён', avatarUrl: null, state: 'removed' },
        { id: 'left', displayName: 'Вышел', avatarUrl: null, state: 'left' },
      ],
    })

    expect(confirmedRaidParticipants(raid).map(({ id }) => id)).toEqual(['owner', 'ready', 'active'])
    expect(participationLabel(raid, 'viewer')).toBe('3 участников')
    expect(participationLabel(raid, 'owner')).toBe('Вы организатор')
  })
})
