import type {
  CreateRaidTemplate as ContractCreateRaidTemplate,
  RaidTemplatePointInput as ContractRaidTemplatePointInput,
} from '@kabanda/contracts'

export const RAID_TEMPLATE_MIN_POINTS = 2
export const RAID_TEMPLATE_MAX_POINTS = 10

export type RaidTemplateFailureCode =
  | 'api_key_rejected'
  | 'provider_unavailable'
  | 'no_route'
  | 'unknown'

export interface RaidTemplateEstimate {
  method: 'straight_segments'
  distanceMeters: number
}

export type RaidTemplatePointInput = ContractRaidTemplatePointInput

export interface RaidTemplatePoint extends RaidTemplatePointInput {
  id: string
  position: number
}

export interface RaidTemplateCover {
  url: string
  sha256: string
  width: number
  height: number
}

export interface RaidTemplateSummary {
  id: string
  kabandaId: string
  scope: 'kabanda' | 'all_authenticated'
  title: string
  version: number
  cover: RaidTemplateCover
  pointCount: number
  estimate: RaidTemplateEstimate
  createdAt: string
  updatedAt: string
}

export interface RaidTemplate extends RaidTemplateSummary {
  points: RaidTemplatePoint[]
}

export type CreateRaidTemplateInput = ContractCreateRaidTemplate

export interface CreateRaidTemplateResponse {
  receipt: {
    operationId: string
    command: 'create-raid-template'
    resultingVersion: 1
    serverAt: string
  }
  template: RaidTemplate
}

export interface DraftRaidTemplatePoint extends RaidTemplatePointInput {
  clientId: string
  geocodeStatus: 'pending' | 'ready' | 'failed'
  geocodeRequestId: string | null
  labelsConfirmed: boolean
}

export type DraftRouteEstimate =
  | { status: 'idle' }
  | { status: 'calculating'; fallbackDistanceMeters: number | null }
  | { status: 'ready'; distanceMeters: number }
  | { status: 'degraded'; distanceMeters: number; failureCode: RaidTemplateFailureCode }

export interface RaidTemplateDraft {
  schemaVersion: 2
  clientDraftId: string
  identityId: string
  kabandaId: string
  scope: 'kabanda' | 'all_authenticated'
  title: string
  coverImage: string | null
  points: DraftRaidTemplatePoint[]
  selectedPointId: string | null
  idempotencyKey: string
  updatedAt: string
}
