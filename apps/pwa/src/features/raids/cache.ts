import Dexie from 'dexie'
import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import type { RaidProjectionRecord } from '../offline/types'
import type { RaidProjection, RaidState } from './types'

const actionableStates = new Set<RaidState>([
  'draft',
  'planned',
  'lobby',
  'active',
  'paused',
  'finalizing',
])

function cacheKey(identityId: string, raidId: string): string {
  return JSON.stringify([identityId, raidId])
}

function isRaidProjection(value: unknown): value is RaidProjection {
  if (!value || typeof value !== 'object') return false
  const raid = value as Partial<RaidProjection>
  return (
    typeof raid.id === 'string' &&
    typeof raid.kabandaId === 'string' &&
    typeof raid.title === 'string' &&
    typeof raid.state === 'string' &&
    typeof raid.version === 'number' &&
    Array.isArray(raid.allowedActions) &&
    Array.isArray(raid.participants)
  )
}

export async function saveRaidProjection(
  identityId: string,
  raid: RaidProjection,
): Promise<void> {
  if ((await getActiveIdentityId()) !== identityId) return
  const record: RaidProjectionRecord = {
    key: cacheKey(identityId, raid.id),
    identityId,
    raidId: raid.id,
    kabandaId: raid.kabandaId,
    state: raid.state,
    savedAt: new Date().toISOString(),
    projection: raid,
  }
  await offlineDb.raidProjections.put(record)
}

function expose(record: RaidProjectionRecord | undefined, identityId: string) {
  if (
    !record ||
    record.identityId !== identityId ||
    !isRaidProjection(record.projection)
  ) {
    return null
  }
  return { raid: record.projection, savedAt: record.savedAt }
}

export async function readRaidProjection(identityId: string, raidId: string) {
  if ((await getActiveIdentityId()) !== identityId) return null
  return expose(await offlineDb.raidProjections.get(cacheKey(identityId, raidId)), identityId)
}

export async function readActionableRaidProjections(identityId: string, kabandaId: string) {
  if ((await getActiveIdentityId()) !== identityId) return []
  const records = await offlineDb.raidProjections
    .where('[identityId+kabandaId+savedAt]')
    .between(
      [identityId, kabandaId, Dexie.minKey],
      [identityId, kabandaId, Dexie.maxKey],
      true,
      true,
    )
    .reverse()
    .toArray()
  return records
    .filter((record) => actionableStates.has(record.state as RaidState))
    .map((record) => expose(record, identityId))
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
}
