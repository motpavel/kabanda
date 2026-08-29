import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activateIdentity } from '../offline/ledger'
import { offlineDb } from '../offline/db'
import { newestFirst, readRaidResult, saveRaidResult } from './cache'
import type { RaidHistoryPage, RaidResult } from './types'

const metrics = { durationSeconds: 60, distanceMeters: 1000, uniquePoints: 1, photos: 1 }
const result: RaidResult = {
  schemaVersion: 1,
  raid: {
    id: 'raid-a', kabandaId: 'kabanda-a', title: 'Рейд', startedAt: '2026-08-28T08:00:00.000Z',
    completedAt: '2026-08-28T09:00:00.000Z', partial: false,
  },
  team: metrics,
  personal: metrics,
  participants: [],
}

describe('identity-bound result cache', () => {
  beforeEach(async () => {
    await offlineDb.delete()
    await offlineDb.open()
    await activateIdentity('user-a')
  })
  afterEach(async () => { await offlineDb.delete() })

  it('does not expose user A result after account switch', async () => {
    await saveRaidResult('user-a', result)
    expect((await readRaidResult('user-a', 'raid-a'))?.result).toEqual(result)
    await activateIdentity('user-b')
    expect(await readRaidResult('user-a', 'raid-a')).toBeNull()
    expect(await readRaidResult('user-b', 'raid-a')).toBeNull()
  })

  it('bounds history and orders it newest first', () => {
    const page: RaidHistoryPage = {
      raids: Array.from({ length: 24 }, (_, index) => ({
        raidId: `raid-${index}`, title: `Рейд ${index}`,
        completedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(), partial: false,
        team: metrics, personal: metrics,
      })),
      nextCursor: 'next',
    }
    const bounded = newestFirst(page)
    expect(bounded.raids).toHaveLength(20)
    expect(bounded.raids[0]?.raidId).toBe('raid-23')
    expect(bounded.raids.at(-1)?.raidId).toBe('raid-4')
  })
})
