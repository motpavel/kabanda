import { ApiError } from '../../lib/http'
import { selectCurrentRaid } from './state'
import type { RaidParticipantState, RaidProjection } from './types'
import type { RaidHistoryItem, RaidMetrics } from '../results/types'

export type ProductionHistoryFilter = 'all' | 'mine'

export function shouldUseProductionCache(reason: unknown): boolean {
  return !(reason instanceof ApiError && reason.status < 500)
}

export function splitActionableRaids(raids: RaidProjection[], identityId: string): {
  current: RaidProjection | null
  upcoming: RaidProjection[]
} {
  const current = selectCurrentRaid(raids)
  const upcoming = raids
    .filter((raid) => raid.id !== current?.id && isJoinedUpcomingRaid(raid, identityId))
    .sort((left, right) => {
      const leftTime = left.scheduledAt ? Date.parse(left.scheduledAt) : Number.POSITIVE_INFINITY
      const rightTime = right.scheduledAt ? Date.parse(right.scheduledAt) : Number.POSITIVE_INFINITY
      if (leftTime !== rightTime) return leftTime - rightTime
      return left.title.localeCompare(right.title, 'ru')
    })
  return { current, upcoming }
}

function isJoinedUpcomingRaid(raid: RaidProjection, identityId: string): boolean {
  if (raid.organizerUserId === identityId) return true
  const state = raid.participants.find(({ id }) => id === identityId)?.state
  return state === 'accepted' || state === 'ready' || state === 'active'
}

export function filterProductionHistory(
  raids: RaidHistoryItem[],
  filter: ProductionHistoryFilter,
): RaidHistoryItem[] {
  if (filter === 'all') return raids
  return raids.filter((raid) => hasActivity(raid.personal))
}

export function participationLabel(raid: RaidProjection, identityId: string): string {
  const participant = raid.participants.find(({ id }) => id === identityId)
  if (participant) return participantStateLabel(participant.state)
  if (raid.organizerUserId === identityId) return 'Вы организатор'
  return `${raid.participants.length} участников`
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
