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

export type CheckInOutboxStatus =
  | 'pending'
  | 'sending'
  | 'retryable'
  | 'accepted'
  | 'needs_action'
  | 'rejected'

export interface CheckInEvidenceRecord {
  latitude: number
  longitude: number
  capturedAt: string
  accuracyMeters: number
}

export interface CheckInOutboxRecord {
  operationId: string
  identityId: string
  kabandaId: string
  raidId: string
  pointSnapshotId: string
  evidence: CheckInEvidenceRecord
  presentParticipantIds: string[]
  organizerAttestation: boolean
  status: CheckInOutboxStatus
  attempts: number
  claimUntil: string | null
  nextAttemptAt: string | null
  createdAt: string
  updatedAt: string
  lastErrorCode: string | null
  response: unknown | null
  fallbackSubmission?: {
    operationId: string
    input: {
      attemptId: string
      mediaId: string
      verifierUserId: string
      presentParticipantIds: string[]
      reason: string
    }
    status: 'pending' | 'submitted'
    fallbackId: string | null
    updatedAt: string
  }
}

export type MediaDraftStatus = 'local' | 'intent' | 'uploading' | 'retryable' | 'accepted' | 'rejected'

export interface MediaDraftRecord {
  operationId: string
  clientDraftId: string
  identityId: string
  kabandaId: string
  raidId: string
  blob: Blob
  sourceSha256: string
  sizeBytes: number
  contentType: 'image/jpeg' | 'image/png' | 'image/webp'
  caption: string | null
  purpose: 'gallery' | 'fallback'
  attemptId: string | null
  status: MediaDraftStatus
  intentId: string | null
  mediaId: string | null
  attempts: number
  claimUntil: string | null
  nextAttemptAt: string | null
  createdAt: string
  updatedAt: string
  lastErrorCode: string | null
}

export interface CheckInSenderLeaseRecord {
  key: string
  identityId: string
  raidId: string
  holderTabId: string
  generation: number
  fenceToken: string
  expiresAt: string
  updatedAt: string
}
