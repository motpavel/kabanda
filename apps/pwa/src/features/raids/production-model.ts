import { ApiError } from '../../lib/http'
import type { KabandaSummary } from '../kabandas/types'
import { selectCurrentRaid } from './state'
import type { RaidParticipant, RaidParticipantState, RaidProjection } from './types'
import type { RaidHistoryItem, RaidMetrics } from '../results/types'

export type ProductionHistoryFilter = 'all' | 'mine'
export type ProductionResourceState = 'loading' | 'ready' | 'stale' | 'access-error' | 'error'

export function productionResourcePolicy(
  state: ProductionResourceState,
  online: boolean,
): { renderContent: boolean; canMutate: boolean } {
  return {
    renderContent: state === 'ready' || state === 'stale',
    canMutate: state === 'ready' && online,
  }
}

export class ProductionRefreshFence {
  private revision = 0
  private mutationInFlight = false

  beginRefresh(): number | null {
    return this.mutationInFlight ? null : this.revision
  }

  beginMutation(): boolean {
    if (this.mutationInFlight) return false
    this.mutationInFlight = true
    this.revision += 1
    return true
  }

  finishMutation(): void {
    this.mutationInFlight = false
  }

  canApplyRefresh(token: number): boolean {
    return !this.mutationInFlight && token === this.revision
  }

  isMutating(): boolean {
    return this.mutationInFlight
  }
}

export function findRaidCreationMembership(
  kabandas: KabandaSummary[],
  kabandaId: string,
): KabandaSummary | null {
  return kabandas.find(({ id }) => id === kabandaId) ?? null
}

export function shouldUseProductionCache(reason: unknown): boolean {
  return !(reason instanceof ApiError && reason.status < 500)
}

export function splitActionableRaids(raids: RaidProjection[], identityId: string): {
  current: RaidProjection | null
  invitations: RaidProjection[]
  upcoming: RaidProjection[]
} {
  const current = selectIdentityCurrentRaid(raids, identityId)
  const candidates = raids.filter((raid) => raid.id !== current?.id)
  const invitations = candidates.filter((raid) => isPendingInvitation(raid, identityId)).sort(bySchedule)
  const upcoming = candidates.filter((raid) => isJoinedUpcomingRaid(raid, identityId)).sort(bySchedule)
  return { current, invitations, upcoming }
}

function isPendingInvitation(raid: RaidProjection, identityId: string): boolean {
  if (raid.state !== 'lobby' || raid.organizerUserId === identityId) return false
  return raid.participants.some(({ id, state }) => id === identityId && state === 'invited')
}

export function selectIdentityCurrentRaid(
  raids: RaidProjection[],
  identityId: string,
): RaidProjection | null {
  return selectCurrentRaid(raids.filter((raid) => (
    raid.organizerUserId === identityId ||
    raid.participants.some(({ id, state }) => id === identityId && state === 'active')
  )))
}

function isJoinedUpcomingRaid(raid: RaidProjection, identityId: string): boolean {
  if (raid.organizerUserId === identityId) return true
  const state = raid.participants.find(({ id }) => id === identityId)?.state
  return state === 'accepted' || state === 'ready' || state === 'active'
}

function bySchedule(left: RaidProjection, right: RaidProjection): number {
  const leftTime = left.scheduledAt ? Date.parse(left.scheduledAt) : Number.POSITIVE_INFINITY
  const rightTime = right.scheduledAt ? Date.parse(right.scheduledAt) : Number.POSITIVE_INFINITY
  if (leftTime !== rightTime) return leftTime - rightTime
  return left.title.localeCompare(right.title, 'ru')
}

export function filterProductionHistory(
  raids: RaidHistoryItem[],
  filter: ProductionHistoryFilter,
): RaidHistoryItem[] {
  if (filter === 'all') return raids
  return raids.filter((raid) => hasActivity(raid.personal))
}

export function confirmedRaidParticipants(
  raid: Pick<RaidProjection, 'participants'>,
): RaidParticipant[] {
  return raid.participants.filter(({ state }) => (
    state === 'accepted' || state === 'ready' || state === 'active'
  ))
}

export function participationLabel(raid: RaidProjection, identityId: string): string {
  if (raid.organizerUserId === identityId) return 'Вы организатор'
  const participant = raid.participants.find(({ id }) => id === identityId)
  if (participant) return participantStateLabel(participant.state)
  return `${confirmedRaidParticipants(raid).length} участников`
}

export function historyAchievement(raid: RaidHistoryItem): {
  label: string
  tone: 'discovery' | 'personal' | 'record'
} {
  if (raid.partial) return { label: 'Частичный итог', tone: 'personal' }
  if (hasActivity(raid.personal)) return { label: 'Вы участвовали', tone: 'record' }
  return { label: 'Итог Кабанды', tone: 'discovery' }
}

function participantStateLabel(state: RaidParticipantState): string {
  return {
    invited: 'Нужно ответить',
    accepted: 'Вы едете',
    ready: 'Вы готовы',
    active: 'Вы в пути',
    declined: 'Вы отказались',
    left: 'Вы вышли',
    removed: 'Вы не участвуете',
  }[state]
}

function hasActivity(metrics: RaidMetrics): boolean {
  return metrics.durationSeconds > 0 || metrics.distanceMeters > 0 || metrics.uniquePoints > 0 || metrics.photos > 0
}
