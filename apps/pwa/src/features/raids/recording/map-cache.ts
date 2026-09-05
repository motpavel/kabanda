import { offlineDb } from '../../offline/db'
import { getActiveIdentityId } from '../../offline/ledger'
import type { RaidMapPoint, RouteTrackProjection } from '../types'

export interface RaidMapCacheRecord {
  key: string
  identityId: string
  raidId: string
  points: RaidMapPoint[]
  track: RouteTrackProjection
}

export async function readRaidMapCache(identityId: string, raidId: string) {
  return offlineDb.transaction('r', offlineDb.identityContext, offlineDb.raidMapCache, async () => {
    if (await getActiveIdentityId() !== identityId) return null
    return await offlineDb.raidMapCache.get(JSON.stringify([identityId, raidId])) ?? null
  })
}

export async function saveRaidMapCache(identityId: string, raidId: string, points: RaidMapPoint[], track: RouteTrackProjection) {
  await offlineDb.transaction('rw', offlineDb.identityContext, offlineDb.raidMapCache, async () => {
    if (await getActiveIdentityId() !== identityId) return
    await offlineDb.raidMapCache.put({ key: JSON.stringify([identityId, raidId]), identityId, raidId, points, track })
  })
}
