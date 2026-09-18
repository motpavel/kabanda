import Dexie, { type EntityTable } from 'dexie'
import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import type { RaidProjectionRecord } from '../offline/types'
import type { RaidProjection, RaidState } from './types'

export const actionableStates = new Set<RaidState>([
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

export function isRaidProjection(value: unknown): value is RaidProjection {
  if (!value || typeof value !== 'object') return false
  const raid = value as Partial<RaidProjection>
  return (
    typeof raid.id === 'string' &&
    typeof raid.kabandaId === 'string' &&
    typeof raid.title === 'string' &&
    typeof raid.state === 'string' &&
    typeof raid.version === 'number' &&
    Boolean(raid.routeStatus) &&
    typeof raid.routeStatus?.status === 'string' &&
    (raid.navigatorLease === null || typeof raid.navigatorLease?.id === 'string') &&
    Array.isArray(raid.allowedActions) &&
    Array.isArray(raid.participants)
  )
}

export async function saveRaidProjection(
  identityId: string,
  raid: RaidProjection,
  current: () => boolean = () => true,
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
  await offlineDb.transaction('rw', offlineDb.raidProjections, offlineDb.identityContext, async () => {
    if (!current() || (await getActiveIdentityId()) !== identityId) return
    const previous = await offlineDb.raidProjections.get(record.key)
    if (!current() || (isRaidProjection(previous?.projection) && previous.projection.version > raid.version)) return
    await offlineDb.raidProjections.put(record)
  })
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

/** Separate read-only database: no schema upgrade of GPS/check-in/photo queues. */
export type RaidReadRecord = {
  key: string; identityId: string; kabandaId: string; savedAt: string; value: unknown
}
class RaidReadDatabase extends Dexie {
  snapshots!: EntityTable<RaidReadRecord, 'key'>
  constructor() {
    super('kabanda-raid-reads-v1')
    this.version(1).stores({ snapshots: 'key, identityId, [identityId+kabandaId]' })
  }
}
export const raidReadDb = new RaidReadDatabase()
export const raidReadKey = (identityId: string, kabandaId: string, kind: string, params: unknown = null) =>
  JSON.stringify([identityId, kabandaId, kind, params])

export async function readSnapshot(identityId: string, key: string) {
  if ((await getActiveIdentityId()) !== identityId) return null
  const record = await raidReadDb.snapshots.get(key)
  return record?.identityId === identityId && (await getActiveIdentityId()) === identityId ? record : null
}

export async function writeSnapshot(record: RaidReadRecord, current: () => boolean) {
  if ((await getActiveIdentityId()) !== record.identityId || !current()) return
  await raidReadDb.transaction('rw', raidReadDb.snapshots, async () => {
    if (current()) await raidReadDb.snapshots.put(record)
  })
}

/** null means unknown, [] is a confirmed empty list; never scan saved cards. */
export async function readActionableRaidProjections(identityId: string, kabandaId: string) {
  const record = await readSnapshot(identityId, raidReadKey(identityId, kabandaId, 'actionable'))
  if (!record || !Array.isArray(record.value) || !record.value.every(isRaidProjection)) return null
  return record.value.map(raid => ({ raid, savedAt: record.savedAt }))
}
