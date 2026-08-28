import type { RaidFinalizationProjection, RaidProjection } from '../raids/types'

export interface RaidMetrics {
  durationSeconds: number
  distanceMeters: number
  uniquePoints: number
  photos: number
}

export interface RaidResult {
  schemaVersion: 1
  raid: {
    id: string
    kabandaId: string
    title: string
    startedAt: string
    completedAt: string
    partial: boolean
  }
  team: RaidMetrics
  personal: RaidMetrics
  participants: Array<{
    userId: string
    displayName: string
    metrics: RaidMetrics
  }>
}

export interface RaidHistoryItem {
  raidId: string
  title: string
  completedAt: string
  partial: boolean
  team: RaidMetrics
  personal: RaidMetrics
}

export interface RaidHistoryPage {
  raids: RaidHistoryItem[]
  nextCursor: string | null
}

export interface ProgressMetrics extends RaidMetrics {
  completedRaids: number
}

export interface KabandaProgress {
  team: ProgressMetrics
  personal: ProgressMetrics
}

export interface FinishInventory {
  routePending: number
  checkInsPending: number
  mediaPending: number
  needsAction: number
}

export interface FinishLocalReview {
  inventory: FinishInventory
}

export interface FinishRaidResponse {
  raid: RaidProjection
  finalization: RaidFinalizationProjection
}

export interface SettleRaidResponse {
  raid: RaidProjection
  result: RaidResult
}
