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
  | 'handoff-navigator'
  | 'finish'
  | 'leave'
  | 'settle-finalization'
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

export type RouteStatusCode = 'awaiting_lease' | 'fresh' | 'stale' | 'paused' | 'stopped'

export interface RouteStatusProjection {
  status: RouteStatusCode
  lastSampleAt: string | null
  lastReceivedAt: string | null
  acceptedSampleCount: number
  missingSequenceCount: number
}

export interface NavigatorLeaseProjection {
  id: string
  generation: number
  issuedAt: string
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
  routeStatus: RouteStatusProjection
  navigatorLease: NavigatorLeaseProjection | null
  finalization: RaidFinalizationProjection | null
  participants: RaidParticipant[]
  allowedActions: RaidAllowedAction[]
}

export interface RaidFinalizationProjection {
  status: 'collecting'
  partial: boolean
  pendingCounts: { claims: number; fallbacks: number; media: number }
  deadlineAt: string
  canSettle: boolean
}

export interface RouteBatchSample {
  operationId: string
  sequence: number
  capturedAt: string
  latitude: number
  longitude: number
  accuracyM: number
  speedMps?: number
  headingDeg?: number
}

export interface RouteBatchInput {
  schemaVersion: 1
  leaseId: string
  clientInstanceId: string
  samples: RouteBatchSample[]
}

export interface RouteBatchResponse {
  batchId: string
  accepted: Array<{ operationId: string; acceptedAt: string }>
  duplicates: Array<{ operationId: string }>
  rejected: Array<{ operationId: string; code: string }>
  routeStatus: RouteStatusProjection
  serverAt: string
}

export interface RouteLeaseResponse {
  receipt: {
    operationId: string
    command: 'acquire-route' | 'recover-route'
    serverAt: string
  }
  raid: RaidProjection
}

export interface HandoffNavigatorInput {
  expectedVersion: number
  navigatorUserId: string
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
