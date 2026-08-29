import { ApiError, requestJson } from '../../lib/http'
import type { RaidProjection } from '../raids/types'
import type {
  FinishInventory,
  FinishRaidResponse,
  KabandaProgress,
  RaidHistoryPage,
  RaidResult,
  SettleRaidResponse,
} from './types'

const raidBase = (raidId: string) => `/api/raids/${encodeURIComponent(raidId)}`

export function finishRaid(
  raidId: string,
  expectedVersion: number,
  inventory: FinishInventory,
  confirmPartial: boolean,
  idempotencyKey: string,
): Promise<FinishRaidResponse> {
  return requestJson(`${raidBase(raidId)}/commands/finish`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ expectedVersion, inventory, confirmPartial }),
  })
}

export function settleFinalization(
  raidId: string,
  expectedVersion: number,
  idempotencyKey: string,
): Promise<SettleRaidResponse> {
  return requestJson(`${raidBase(raidId)}/finalization/settle`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ expectedVersion }),
  })
}

export async function leaveRaid(
  raidId: string,
  expectedVersion: number,
  idempotencyKey: string,
): Promise<RaidProjection> {
  const response = await requestJson<{ raid: RaidProjection }>(
    `${raidBase(raidId)}/participants/me/leave`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ expectedVersion }),
    },
  )
  return response.raid
}

export async function getRaidResult(raidId: string): Promise<RaidResult> {
  return (await requestJson<{ result: RaidResult }>(`${raidBase(raidId)}/result`)).result
}

export function listRaidHistory(
  kabandaId: string,
  limit = 12,
  cursor?: string,
): Promise<RaidHistoryPage> {
  const query = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 20)) })
  if (cursor) query.set('cursor', cursor)
  return requestJson(`/api/kabandas/${encodeURIComponent(kabandaId)}/raids/history?${query}`)
}

export async function getKabandaProgress(kabandaId: string): Promise<KabandaProgress> {
  return (await requestJson<{ progress: KabandaProgress }>(
    `/api/kabandas/${encodeURIComponent(kabandaId)}/progress`,
  )).progress
}

export async function getShareCard(raidId: string): Promise<Blob> {
  const response = await fetch(`${raidBase(raidId)}/share-card`, {
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!response.ok) {
    let error: { code?: string; message?: string } = {}
    try {
      error = (await response.json()).error ?? {}
    } catch {
      // The private image endpoint may return an empty error body.
    }
    throw new ApiError(error.code ?? 'SHARE_CARD_FAILED', error.message ?? 'Карточка недоступна', response.status)
  }
  const blob = await response.blob()
  if (blob.type !== 'image/png') throw new ApiError('SHARE_CARD_INVALID', 'Сервер вернул неверный формат карточки', 502)
  return blob
}
