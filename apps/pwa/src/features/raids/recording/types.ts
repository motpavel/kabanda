import type {
  RecorderSessionRecord,
  RecorderWriterLeaseRecord,
  RouteOutboxRecord,
} from '../../offline/types'
import type { RouteStatusProjection } from '../types'

export interface RecorderContext {
  identityId: string
  kabandaId: string
  raidId: string
  navigatorLeaseId: string
  leaseGeneration: number
}

export interface WriterFence {
  key: string
  identityId: string
  raidId: string
  navigatorLeaseId: string
  leaseGeneration: number
  holderTabId: string
  writerGeneration: number
  fenceToken: string
  expiresAt: string
}

export interface CapturedRouteSample {
  capturedAt: string
  latitude: number
  longitude: number
  accuracyM: number
  speedMps: number | null
  headingDeg: number | null
}

export interface ClaimedRouteBatch {
  batchId: string
  context: RecorderContext
  clientInstanceId: string
  rows: RouteOutboxRecord[]
}

export interface RecorderLocalStats {
  pendingCount: number
  preliminaryDistanceM: number
  lastPersistedSampleAt: string | null
}

export type RecorderPhase =
  | 'ineligible'
  | 'standby'
  | 'recovering'
  | 'waiting'
  | 'fresh'
  | 'stale'
  | 'blocked'
  | 'error'
  | 'paused'

export type WakeLockPhase = 'unsupported' | 'requesting' | 'held' | 'released' | 'failed'

export interface RouteRecorderView {
  phase: RecorderPhase
  wakeLock: WakeLockPhase
  pendingCount: number
  preliminaryDistanceM: number
  lastPersistedSampleAt: string | null
  routeStatus: RouteStatusProjection
  message: string | null
  recover: () => void
  flush: () => Promise<void>
}

export type StoredRecorderSession = RecorderSessionRecord
export type StoredWriterLease = RecorderWriterLeaseRecord
