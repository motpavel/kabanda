import type { RaidProjection } from '../raids/types'
import { settleFinalization } from './api'
import { saveRaidResult } from './cache'
import { readResultOperationAttempt, resultOperationStorageKey, saveResultOperationAttempt, selectResultOperationAttempt } from './operation'

export function canCompleteRaid(raid: RaidProjection, now = Date.now()): boolean {
  if (raid.state !== 'finalizing' || !raid.allowedActions.includes('settle-finalization') || !raid.finalization) return false
  const { pendingCounts, deadlineAt } = raid.finalization
  return pendingCounts.claims + pendingCounts.fallbacks + pendingCounts.media === 0 || Date.parse(deadlineAt) <= now
}

/** Confirmation of finish also authorizes saving its final result. */
export async function completeReadyRaid(identityId: string, raid: RaidProjection): Promise<RaidProjection> {
  if (!canCompleteRaid(raid)) return raid
  const storageKey = resultOperationStorageKey('settle', identityId, raid.id)
  const payload = { expectedVersion: raid.version }
  const attempt = selectResultOperationAttempt(readResultOperationAttempt<{ expectedVersion: number }>(storageKey), JSON.stringify([raid.id, payload]), payload)
  saveResultOperationAttempt(storageKey, attempt)
  const response = await settleFinalization(raid.id, attempt.payload.expectedVersion, attempt.key)
  // A full local disk must not hide an already saved server result.
  await saveRaidResult(identityId, response.result).catch(() => undefined)
  return response.raid
}
