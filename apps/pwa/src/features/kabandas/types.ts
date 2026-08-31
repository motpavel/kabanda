export interface KabandaSummary {
  id: string
  name: string
  avatar: string
  coverImage: string | null
  role: 'owner' | 'member'
  memberCount: number
  pointsCollectionId: string | null
}

export interface KabandaMember {
  id: string
  displayName: string
  role: 'owner' | 'member'
  avatarUrl: string | null
}

export interface KabandaPoint {
  id: string
  stableId: string
  name: string
  latitude: number
  longitude: number
  verificationStatus: 'source_checked' | 'field_verified' | 'rejected'
  visitedByMe: boolean
  visitedByTeam: boolean
  visitedByMeCount: number
  visitedByTeamCount: number
}

export interface InvitePreview {
  continuation: string
  kabanda: KabandaSummary
  inviterName: string
  expiresAt: string
  requiresAuth: boolean
  accepted: boolean
}

export interface CreatedInvite {
  id: string
  token: string
  expiresAt: string
}

export interface PointPage {
  points: KabandaPoint[]
  nextCursor: string | null
}

export type ProviderState = 'checking' | 'ready' | 'failed'
export type PointPresentation = 'map' | 'list'
