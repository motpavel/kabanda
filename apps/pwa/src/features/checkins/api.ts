import { ApiError, requestJson } from '../../lib/http'
import { diagnosticRequestHeaders } from '../../lib/diagnostics'
import type {
  CheckInClaim,
  CheckInFallback,
  CheckInResponse,
  ClaimActionResponse,
  CreateCheckInInput,
  CreateFallbackInput,
  FallbackResponse,
  MediaIntentInput,
  MediaIntentResponse,
  MediaUploadResponse,
  NearbyPointsResponse,
  RaidMediaPage,
} from './types'

const raidBase = (raidId: string) => `/api/raids/${encodeURIComponent(raidId)}`

export function getNearbyPoints(
  raidId: string,
  latitude: number,
  longitude: number,
): Promise<NearbyPointsResponse> {
  const query = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), limit: '5' })
  return requestJson(`${raidBase(raidId)}/check-ins/nearby?${query}`)
}

export async function listPendingFallbacks(raidId: string): Promise<CheckInFallback[]> {
  const response = await requestJson<{ fallbacks: CheckInFallback[] }>(
    `${raidBase(raidId)}/check-in-fallbacks?status=pending`,
  )
  return response.fallbacks
}

export function submitCheckIn(
  raidId: string,
  operationId: string,
  input: CreateCheckInInput,
): Promise<CheckInResponse> {
  return requestJson(`${raidBase(raidId)}/check-ins`, {
    method: 'POST',
    headers: { 'Idempotency-Key': operationId },
    body: JSON.stringify(input),
  })
}

export async function listPendingClaims(raidId: string): Promise<CheckInClaim[]> {
  const response = await requestJson<{ claims: CheckInClaim[] }>(
    `${raidBase(raidId)}/check-in-claims?status=pending`,
  )
  return response.claims
}

export function actOnClaim(
  raidId: string,
  claimId: string,
  action: 'confirm' | 'decline',
  idempotencyKey: string,
): Promise<ClaimActionResponse> {
  return requestJson(`${raidBase(raidId)}/check-in-claims/${encodeURIComponent(claimId)}/${action}`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
  })
}

export function createFallback(
  raidId: string,
  idempotencyKey: string,
  input: CreateFallbackInput,
): Promise<FallbackResponse> {
  return requestJson(`${raidBase(raidId)}/check-in-fallbacks`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  })
}

export function actOnFallback(
  raidId: string,
  fallbackId: string,
  action: 'confirm' | 'decline',
  idempotencyKey: string,
): Promise<FallbackResponse> {
  return requestJson(`${raidBase(raidId)}/check-in-fallbacks/${encodeURIComponent(fallbackId)}/${action}`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
  })
}

export function createMediaIntent(
  raidId: string,
  operationId: string,
  input: MediaIntentInput,
): Promise<MediaIntentResponse> {
  return requestJson(`${raidBase(raidId)}/media/intents`, {
    method: 'POST',
    headers: { 'Idempotency-Key': operationId },
    body: JSON.stringify(input),
  })
}

export async function uploadMediaContent(
  raidId: string,
  intentId: string,
  capability: string,
  sha256: string,
  blob: Blob,
): Promise<MediaUploadResponse> {
  const response = await fetch(`${raidBase(raidId)}/media/intents/${encodeURIComponent(intentId)}/content`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      'Content-Type': blob.type,
      ...diagnosticRequestHeaders(),
      'X-Upload-Capability': capability,
      'X-Content-SHA256': sha256,
    },
    body: blob,
  })
  const body = await response.json()
  if (!response.ok) {
    const error = body?.error
    throw new ApiError(
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? 'Ошибка загрузки',
      response.status,
      error?.errorId ?? response.headers.get('X-Kabanda-Request-Id'),
      response.headers.get('X-Kabanda-Api-Build'),
      error?.operationRef ?? response.headers.get('X-Kabanda-Operation-Ref'),
    )
  }
  return body as MediaUploadResponse
}

export function listRaidMedia(raidId: string): Promise<RaidMediaPage> {
  return requestJson(`${raidBase(raidId)}/media?limit=24`)
}

export function mediaContentUrl(raidId: string, mediaId: string): string {
  return `${raidBase(raidId)}/media/${encodeURIComponent(mediaId)}/content`
}
