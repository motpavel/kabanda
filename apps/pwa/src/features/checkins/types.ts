export interface CheckInPolicy {
  version: 'v1'
  radiusMeters: 50
  maxAgeSeconds: 60
  maxAccuracyMeters: 50
}

export interface NearbyPoint {
  pointSnapshotId: string
  sourcePointId: string
  name: string
  latitude: number
  longitude: number
  distanceMeters: number
  creditedByMe: boolean
  creditedByTeam: boolean
}

export interface NearbyPointsResponse {
  policy: CheckInPolicy
  points: NearbyPoint[]
}

export interface CheckInEvidence {
  latitude: number
  longitude: number
  capturedAt: string
  accuracyMeters: number
}

export interface CreateCheckInInput {
  repeatVisit?: boolean
  pointSnapshotId: string
  evidence: CheckInEvidence
  presentParticipantIds: string[]
  organizerAttestation: boolean
}

export interface CheckInCredit {
  id: string
  userId: string
  pointSnapshotId: string
  source: 'gps' | 'organizer_attestation' | 'claim' | 'media_fallback'
  creditedAt: string
}

export interface CheckInClaim {
  id: string
  attemptId: string
  userId: string
  status: 'pending' | 'confirmed' | 'declined' | 'expired'
  expiresAt: string
}

export type ManualVerificationReason = 'location_expired' | 'accuracy_insufficient' | 'too_far'

export interface CheckInResponse {
  operationId: string
  outcome: 'accepted' | 'needs_manual_verification'
  reason: ManualVerificationReason | null
  attemptId: string
  point: { pointSnapshotId: string; sourcePointId: string; name: string }
  distanceMeters?: number
  credits: CheckInCredit[]
  claims: CheckInClaim[]
}

export interface ClaimActionResponse {
  claim: CheckInClaim
  credit?: CheckInCredit
}

export interface CheckInFallback {
  id: string
  attemptId: string
  mediaId: string
  verifierUserId: string
  status: 'pending_verifier' | 'confirmed' | 'declined' | 'expired'
  reason: string
  expiresAt: string
}

export interface CreateFallbackInput {
  attemptId: string
  mediaId: string
  verifierUserId: string
  presentParticipantIds: string[]
  reason: string
}

export interface FallbackResponse {
  fallback: CheckInFallback
  credits?: CheckInCredit[]
}

export interface MediaIntentInput {
  sourceSha256: string
  sizeBytes: number
  contentType: 'image/jpeg' | 'image/png' | 'image/webp'
  caption: string | null
  purpose: 'gallery' | 'fallback'
  attemptId?: string
}

export interface MediaIntentResponse {
  intentId: string
  uploadCapability: string
  expiresAt: string
  state: 'pending_upload'
}

export interface RaidMedia {
  id: string
  state: 'ready'
  contentType: 'image/jpeg'
  sizeBytes: number
  width: number
  height: number
  caption: string | null
  purpose: 'gallery' | 'fallback'
  createdAt: string
  uploaderUserId: string
}

export interface MediaUploadResponse {
  media: RaidMedia
}

export interface RaidMediaPage {
  media: RaidMedia[]
  nextCursor: string | null
}

export interface OneShotCoordinate {
  latitude: number
  longitude: number
  accuracyMeters: number
  capturedAt: string
}
