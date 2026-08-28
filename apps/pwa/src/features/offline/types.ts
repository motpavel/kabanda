export type OutboxOperationKind = 'route.sample' | 'check-in.submit' | 'media.register'
export type OutboxOperationStatus = 'pending' | 'sending' | 'failed'

export interface LocalIdentity {
  userId: string
  activatedAt: string
}

export interface IdentityContext {
  key: 'active'
  userId: string
  changedAt: string
}

export interface OutboxOperation {
  id: string
  identityId: string
  kind: OutboxOperationKind
  aggregateId: string
  payload: unknown
  createdAt: string
  status: OutboxOperationStatus
  attempts: number
  lastError?: string
}

export interface PointCollectionProjection {
  key: string
  identityId: string
  kabandaId: string
  collectionId: string
  savedAt: string
  points: unknown[]
}

export interface RaidProjectionRecord {
  key: string
  identityId: string
  raidId: string
  kabandaId: string
  state: string
  savedAt: string
  projection: unknown
}

export type RouteOutboxStatus =
  | 'pending'
  | 'sending'
  | 'retryable'
  | 'accepted'
  | 'rejected'

export interface RouteOutboxRecord {
  id: string
  identityId: string
  kabandaId: string
  raidId: string
  navigatorLeaseId: string
  leaseGeneration: number
  clientInstanceId: string
  sequence: number
  capturedAt: string
  latitude: number
  longitude: number
  accuracyM: number
  speedMps: number | null
  headingDeg: number | null
  status: RouteOutboxStatus
  batchId: string | null
  attempts: number
  nextAttemptAt: string | null
  claimUntil: string | null
  lastErrorCode?: string
  acceptedAt?: string
}

export interface RecorderSessionRecord {
  key: string
  identityId: string
  kabandaId: string
  raidId: string
  navigatorLeaseId: string
  leaseGeneration: number
  clientInstanceId: string
  wanted: boolean
  nextSequence: number
  lastPersistedSampleAt: string | null
  lastLatitude: number | null
  lastLongitude: number | null
  preliminaryDistanceM: number
  updatedAt: string
}

export interface RecorderClientRecord {
  key: string
  identityId: string
  kabandaId: string
  raidId: string
  clientInstanceId: string
  leaseActionFingerprint: string | null
  leaseActionKey: string | null
  updatedAt: string
}

export interface RecorderWriterLeaseRecord {
  key: string
  identityId: string
  raidId: string
  navigatorLeaseId: string
  leaseGeneration: number
  holderTabId: string
  writerGeneration: number
  fenceToken: string
  expiresAt: string
  updatedAt: string
}
