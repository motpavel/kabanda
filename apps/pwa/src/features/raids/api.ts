import { requestJson } from '../../lib/http'
import { liveRaid, type RaidLiveSnapshot } from './live-feed'
export type { RaidLiveSnapshot } from './live-feed'
import type {
  CreateRaidInput, RaidAllowedAction, RaidMapPoint, RaidPointPresenceRoster, RaidPresenceRoster,
  RaidProjection, RouteBatchInput, RouteBatchResponse, RouteTrackProjection, RouteLeaseResponse,
  ReadinessReportInput, ReadinessReportResponse,
} from './types'

export async function createRaid(kabandaId: string,input: CreateRaidInput,idempotencyKey: string): Promise<RaidProjection> {
  const response = await requestJson<{ raid: RaidProjection }>(`/api/kabandas/${encodeURIComponent(kabandaId)}/raids`, {
    method: 'POST',headers: { 'Idempotency-Key': idempotencyKey },body: JSON.stringify({ ...input, openLobby: !input.scheduledAt }),
  })
  return response.raid
}
export function requestRouteLease(raidId: string,action: 'acquire' | 'recover',expectedVersion: number,clientInstanceId: string,idempotencyKey: string): Promise<RouteLeaseResponse> {
  return requestJson<RouteLeaseResponse>(`/api/raids/${encodeURIComponent(raidId)}/route/lease/${action}`, {
    method: 'POST',headers: { 'Idempotency-Key': idempotencyKey },body: JSON.stringify({ expectedVersion, clientInstanceId }),
  })
}
export function sendRouteBatch(raidId: string,batchId: string,input: RouteBatchInput): Promise<RouteBatchResponse> {
  return requestJson<RouteBatchResponse>(`/api/raids/${encodeURIComponent(raidId)}/route/batches`, {
    method: 'POST',headers: { 'Idempotency-Key': batchId },body: JSON.stringify(input),
  })
}
export async function getRouteTrack(raidId: string): Promise<RouteTrackProjection> {
  return (await requestJson<{ track: RouteTrackProjection }>(`/api/raids/${encodeURIComponent(raidId)}/route/track`)).track
}
export async function getRaidMapPoints(raidId: string): Promise<RaidMapPoint[]> {
  return (await requestJson<{ points: RaidMapPoint[] }>(`/api/raids/${encodeURIComponent(raidId)}/map-points`)).points
}
export function getRaidPresence(raidId: string): Promise<RaidPresenceRoster> {
  return requestJson<RaidPresenceRoster>(`/api/raids/${encodeURIComponent(raidId)}/presence`)
}
export function reportRaidPresence(raidId: string,evidence: { latitude: number; longitude: number; capturedAt: string; accuracyMeters: number }): Promise<RaidPresenceRoster> {
  return requestJson<RaidPresenceRoster>(`/api/raids/${encodeURIComponent(raidId)}/presence/me`, {method: 'PUT',body: JSON.stringify(evidence)})
}
export function setManualRaidPresence(raidId: string,participantId: string,present: boolean): Promise<RaidPresenceRoster> {
  return requestJson<RaidPresenceRoster>(`/api/raids/${encodeURIComponent(raidId)}/presence/${encodeURIComponent(participantId)}/manual`, {method: 'PUT',body: JSON.stringify({ present })})
}
export function getRaidPointPresence(raidId: string,pointSnapshotId: string): Promise<RaidPointPresenceRoster> {
  const query = new URLSearchParams({ pointSnapshotId })
  return requestJson<RaidPointPresenceRoster>(`/api/raids/${encodeURIComponent(raidId)}/check-ins/presence?${query}`)
}
export async function listActionableRaids(kabandaId: string): Promise<RaidProjection[]> {
  return (await requestJson<{ raids: RaidProjection[] }>(`/api/kabandas/${encodeURIComponent(kabandaId)}/raids?scope=actionable`)).raids
}
export async function getRaid(raidId: string): Promise<RaidProjection> { return (await getRaidSnapshot(raidId)).raid }
export function getRaidSnapshot(raidId: string): Promise<RaidLiveSnapshot> { return liveRaid(raidId).refresh() }

export async function sendRaidCommand(raidId: string,
  command: Extract<RaidAllowedAction, 'open-lobby' | 'assign-navigator' | 'start' | 'pause' | 'resume' | 'cancel' | 'handoff-navigator'>,
  expectedVersion: number,idempotencyKey: string,extra?: { navigatorUserId: string }): Promise<RaidProjection> {
  const response = await requestJson<{ raid: RaidProjection }>(`/api/raids/${encodeURIComponent(raidId)}/commands/${command}`, {
    method: 'POST',headers: { 'Idempotency-Key': idempotencyKey },body: JSON.stringify({ expectedVersion, ...extra }),
  })
  return response.raid
}
export async function sendParticipantCommand(raidId: string,command: Extract<RaidAllowedAction, 'accept' | 'decline' | 'ready'>,
  expectedVersion: number,idempotencyKey: string): Promise<RaidProjection> {
  const response = await requestJson<{ raid: RaidProjection }>(`/api/raids/${encodeURIComponent(raidId)}/participants/me/${command}`, {
    method: 'POST',headers: { 'Idempotency-Key': idempotencyKey },body: JSON.stringify({ expectedVersion }),
  })
  return response.raid
}
export function reportReadiness(raidId: string,input: ReadinessReportInput,idempotencyKey: string): Promise<ReadinessReportResponse> {
  return requestJson<ReadinessReportResponse>(`/api/raids/${encodeURIComponent(raidId)}/readiness`, {
    method: 'POST',headers: { 'Idempotency-Key': idempotencyKey },body: JSON.stringify(input),
  })
}
export async function setRaidDestination(raidId: string, input: { expectedVersion: number; pointSnapshotId: string }, operationId: string): Promise<RaidProjection> {
  const response = await requestJson<{ raid: RaidProjection }>(`/api/raids/${encodeURIComponent(raidId)}/destination`, {
    method: 'PUT', headers: { 'Idempotency-Key': operationId }, body: JSON.stringify(input),
  })
  return response.raid
}
export interface PrepareRaidInput {
  expectedVersion: number
  readiness?: Omit<ReadinessReportInput, 'expectedVersion'>
  presence?: { latitude: number; longitude: number; capturedAt: string; accuracyMeters: number }
}
export function prepareRaid(raidId: string, input: PrepareRaidInput, key: string): Promise<{ raid: RaidProjection; presence: RaidPresenceRoster }> {
  return requestJson(`/api/raids/${encodeURIComponent(raidId)}/prepare`, {method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(input)})
}
export async function updateRaidSetup(raidId: string, input: { expectedVersion: number; title: string; scheduledAt: string | null; description: string | null; meetingPlace: string | null }, key: string): Promise<RaidProjection> {
  return (await requestJson<{ raid: RaidProjection }>(`/api/raids/${encodeURIComponent(raidId)}/setup`, { method: 'PATCH', headers: { 'Idempotency-Key': key }, body: JSON.stringify(input) })).raid
}
