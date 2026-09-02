import { requestJson } from '../../lib/http'
import type {
  CreateRaidInput,
  RaidAllowedAction,
  RaidMapPoint,
  RaidPointPresenceRoster,
  RaidPresenceRoster,
  RaidProjection,
  RouteBatchInput,
  RouteBatchResponse,
  RouteTrackProjection,
  RouteLeaseResponse,
  ReadinessReportInput,
  ReadinessReportResponse,
} from './types'

export async function createRaid(
  kabandaId: string,
  input: CreateRaidInput,
  idempotencyKey: string,
): Promise<RaidProjection> {
  const response = await requestJson<{ raid: RaidProjection }>(
    `/api/kabandas/${encodeURIComponent(kabandaId)}/raids`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    },
  )
  return response.raid
}

export function requestRouteLease(
  raidId: string,
  action: 'acquire' | 'recover',
  expectedVersion: number,
  clientInstanceId: string,
  idempotencyKey: string,
): Promise<RouteLeaseResponse> {
  return requestJson<RouteLeaseResponse>(
    `/api/raids/${encodeURIComponent(raidId)}/route/lease/${action}`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ expectedVersion, clientInstanceId }),
    },
  )
}

export function sendRouteBatch(
  raidId: string,
  batchId: string,
  input: RouteBatchInput,
): Promise<RouteBatchResponse> {
  return requestJson<RouteBatchResponse>(
    `/api/raids/${encodeURIComponent(raidId)}/route/batches`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': batchId },
      body: JSON.stringify(input),
    },
  )
}

export async function getRouteTrack(raidId: string): Promise<RouteTrackProjection> {
  const response = await requestJson<{ track: RouteTrackProjection }>(
    `/api/raids/${encodeURIComponent(raidId)}/route/track`,
  )
  return response.track
}

export async function getRaidMapPoints(raidId: string): Promise<RaidMapPoint[]> {
  const response = await requestJson<{ points: RaidMapPoint[] }>(
    `/api/raids/${encodeURIComponent(raidId)}/map-points`,
  )
  return response.points
}

export function getRaidPresence(raidId: string): Promise<RaidPresenceRoster> {
  return requestJson<RaidPresenceRoster>(`/api/raids/${encodeURIComponent(raidId)}/presence`)
}

export function reportRaidPresence(
  raidId: string,
  evidence: { latitude: number; longitude: number; capturedAt: string; accuracyMeters: number },
): Promise<RaidPresenceRoster> {
  return requestJson<RaidPresenceRoster>(`/api/raids/${encodeURIComponent(raidId)}/presence/me`, {
    method: 'PUT',
    body: JSON.stringify(evidence),
  })
}

export function setManualRaidPresence(
  raidId: string,
  participantId: string,
  present: boolean,
): Promise<RaidPresenceRoster> {
  return requestJson<RaidPresenceRoster>(`/api/raids/${encodeURIComponent(raidId)}/presence/${encodeURIComponent(participantId)}/manual`, {
    method: 'PUT',
    body: JSON.stringify({ present }),
  })
}

export function getRaidPointPresence(
  raidId: string,
  pointSnapshotId: string,
): Promise<RaidPointPresenceRoster> {
  const query = new URLSearchParams({ pointSnapshotId })
  return requestJson<RaidPointPresenceRoster>(
    `/api/raids/${encodeURIComponent(raidId)}/check-ins/presence?${query}`,
  )
}

export async function listActionableRaids(kabandaId: string): Promise<RaidProjection[]> {
  const response = await requestJson<{ raids: RaidProjection[] }>(
    `/api/kabandas/${encodeURIComponent(kabandaId)}/raids?scope=actionable`,
  )
  return response.raids
}

export async function getRaid(raidId: string): Promise<RaidProjection> {
  const response = await requestJson<{ raid: RaidProjection }>(
    `/api/raids/${encodeURIComponent(raidId)}`,
  )
  return response.raid
}

export async function sendRaidCommand(
  raidId: string,
  command: Extract<RaidAllowedAction, 'open-lobby' | 'assign-navigator' | 'start' | 'pause' | 'resume' | 'cancel' | 'handoff-navigator'>,
  expectedVersion: number,
  idempotencyKey: string,
  extra?: { navigatorUserId: string },
): Promise<RaidProjection> {
  const response = await requestJson<{ raid: RaidProjection }>(
    `/api/raids/${encodeURIComponent(raidId)}/commands/${command}`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ expectedVersion, ...extra }),
    },
  )
  return response.raid
}

export async function sendParticipantCommand(
  raidId: string,
  command: Extract<RaidAllowedAction, 'accept' | 'decline' | 'ready'>,
  expectedVersion: number,
  idempotencyKey: string,
): Promise<RaidProjection> {
  const response = await requestJson<{ raid: RaidProjection }>(
    `/api/raids/${encodeURIComponent(raidId)}/participants/me/${command}`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ expectedVersion }),
    },
  )
  return response.raid
}

export function reportReadiness(
  raidId: string,
  input: ReadinessReportInput,
  idempotencyKey: string,
): Promise<ReadinessReportResponse> {
  return requestJson<ReadinessReportResponse>(
    `/api/raids/${encodeURIComponent(raidId)}/readiness`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    },
  )
}
