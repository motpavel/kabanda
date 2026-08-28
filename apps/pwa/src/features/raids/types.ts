export type RaidState =
  | 'draft'
  | 'planned'
  | 'lobby'
  | 'active'
  | 'paused'
  | 'finalizing'
  | 'completed'
  | 'cancelled'

export type RaidParticipantState =
  | 'invited'
  | 'accepted'
  | 'ready'
  | 'active'
  | 'declined'
  | 'left'
  | 'removed'

export type RaidAllowedAction =
  | 'open-lobby'
  | 'assign-navigator'
  | 'start'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'accept'
  | 'decline'
  | 'ready'

export interface RaidParticipant {
  id: string
  displayName: string
  avatarUrl: string | null
  state: RaidParticipantState
}

export type ReadinessStatus = 'pass' | 'warn' | 'fail' | 'unknown'

export interface RaidReadinessSummary {
  status: ReadinessStatus
  blockers: string[]
  expiresAt: string
  raidVersion: number
}

export interface RaidProjection {
  id: string
  kabandaId: string
  title: string
  state: RaidState
  version: number
  scheduledAt: string | null
  description: string | null
  organizerUserId: string
  navigatorUserId: string | null
  navigatorReady: boolean
  navigatorBlockers: string[]
  navigatorWarnings: string[]
  participants: RaidParticipant[]
  allowedActions: RaidAllowedAction[]
}

export interface CreateRaidInput {
  title: string
  description: string | null
  scheduledAt: string | null
}

export interface ReadinessReportInput {
  expectedVersion: number
  appMode: 'standalone' | 'browser'
  locationPermission: 'granted' | 'prompt' | 'denied' | 'unsupported' | 'unknown'
  coordinateMeasuredAt: string | null
  accuracyM: number | null
  indexedDbWritable: boolean
  storageAvailable: boolean | null
  online: boolean
  measuredAt: string
}

export interface ReadinessReportResponse {
  report: RaidReadinessSummary
  raid: RaidProjection
}

export interface LocalReadinessFacts extends Omit<ReadinessReportInput, 'expectedVersion'> {
  serviceWorkerControlled: boolean
  wakeLockSupported: boolean
}

export interface ReadinessRow {
  id: string
  label: string
  detail: string
  status: ReadinessStatus
}
