import { requestJson } from '../../lib/http'
import type {
  CreateRaidInput,
  RaidAllowedAction,
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
