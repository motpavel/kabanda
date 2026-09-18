import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryPage } from '@kabanda/contracts/exploration'
import { offlineDb } from '../offline/db'
import { activateIdentity, enqueueOperation } from '../offline/ledger'
import { raidReadDb } from '../raids/cache'
import { actionableResource, resetRaidResources } from '../raids/resources'
import { ApiError, requestJson } from '../../lib/http'
import { notifyConfirmedWrite } from '../../lib/api-events'
import { pagedHistoryResource, pointProgressResource, requestMoreHistory } from './exploration-resources'

vi.mock('../../lib/http', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/http')>(), requestJson: vi.fn() }))
const identity = '11111111-1111-4111-8111-111111111111'
const team = '22222222-2222-4222-8222-222222222222'
const metrics = { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0 }
const page = (start: number, scope: 'all' | 'mine' = 'all'): HistoryPage => ({ schemaVersion: 2, scope,
  raids: Array.from({ length: 12 }, (_, index) => ({ raidId: `44444444-4444-4444-8444-${String(start + index).padStart(12, '0')}`,
    title: `Рейд ${start + index}`, completedAt: '2026-09-18T12:00:00Z', partial: false, participated: true, team: metrics, personal: metrics })),
  nextCursor: start === 1 ? 'next' : null,
})
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

beforeEach(async () => {
  resetRaidResources(); vi.clearAllMocks()
  await offlineDb.delete(); await offlineDb.open()
  await raidReadDb.delete(); await raidReadDb.open()
  await activateIdentity(identity)
})
afterEach(() => resetRaidResources())

describe('shared exploration resources', () => {
  it('retains visible cards after a later-page failure and retries the same window without duplicates', async () => {
    let fail = true
    vi.mocked(requestJson).mockImplementation(async path => {
      if (String(path).includes('cursor=')) { if (fail) throw new Error('offline'); return page(13) }
      return page(1)
    })
    const entry = pagedHistoryResource(identity, team, 'all')
    await entry.refresh(); await entry.settled()
    await Promise.all([requestMoreHistory(entry), requestMoreHistory(entry)])
    expect(entry.state.status).toBe('stale')
    expect(entry.state.data?.raids).toHaveLength(12)
    expect(vi.mocked(requestJson).mock.calls.filter(([url]) => String(url).includes('cursor='))).toHaveLength(1)
    fail = false
    await entry.refresh(); await entry.settled()
    expect(entry.state.status).toBe('ready')
    expect(entry.state.data?.raids).toHaveLength(24)
    expect(new Set(entry.state.data?.raids.map(row => row.raidId)).size).toBe(24)
    resetRaidResources()
    const restored = pagedHistoryResource(identity, team, 'all')
    await restored.hydrate()
    expect(restored.state.data?.raids).toHaveLength(24)
    expect(restored.state.status).toBe('stale')
  })

  it('keeps complete all/mine windows separate, including authoritative empty mine', async () => {
    vi.mocked(requestJson).mockImplementation(async path => String(path).includes('scope=mine') ? { schemaVersion: 2, scope: 'mine', raids: [], nextCursor: null } : page(1))
    const all = pagedHistoryResource(identity, team, 'all')
    const mine = pagedHistoryResource(identity, team, 'mine')
    await all.refresh(); await mine.refresh(); await all.settled(); await mine.settled()
    expect(all.state.data?.raids).toHaveLength(12)
    expect(mine.state.data?.raids).toEqual([])
    expect(all.key).not.toBe(mine.key)
    resetRaidResources()
    const restored = pagedHistoryResource(identity, team, 'mine')
    await restored.hydrate()
    expect(restored.state.data?.raids).toEqual([])
  })

  it('a denial fences a pending page without erasing operational queues', async () => {
    await enqueueOperation('check-in.submit', 'ride', { synthetic: true })
    const delayed = deferred<unknown>()
    let nextRequested = false
    vi.mocked(requestJson).mockImplementation(async path => {
      if (String(path).includes('scope=actionable')) throw new ApiError('FORBIDDEN', 'denied', 403)
      if (String(path).includes('cursor=')) { nextRequested = true; return delayed.promise }
      return page(1)
    })
    const entry = pagedHistoryResource(identity, team, 'all')
    await entry.refresh(); await entry.settled()
    const pending = requestMoreHistory(entry)
    await vi.waitFor(() => expect(nextRequested).toBe(true))
    await actionableResource(identity, team, 'member').refresh()
    delayed.resolve(page(13))
    await pending; await entry.settled()
    expect(entry.state).toMatchObject({ data: null, status: 'access-error' })
    expect(await raidReadDb.snapshots.get(entry.key)).toBeUndefined()
    expect(await offlineDb.outbox.count()).toBe(1)
  })

  it('an identity switch retires a late history response before it can write disk', async () => {
    const delayed = deferred<unknown>()
    vi.mocked(requestJson).mockReturnValue(delayed.promise)
    const entry = pagedHistoryResource(identity, team, 'all')
    const pending = entry.refresh()
    resetRaidResources('other')
    await activateIdentity('other')
    delayed.resolve(page(1))
    await pending; await entry.settled()
    expect(entry.state.data).toBeNull()
    expect(await raidReadDb.snapshots.count()).toBe(0)
  })

  it('confirmed check-ins invalidate visits but do not invent a successful count', async () => {
    vi.mocked(requestJson).mockResolvedValue({ category: 'stores', collectionId: null, complete: true, points: [{ pointId: null, stableId: 'store', personalCount: 0, teamCount: 0 }] })
    const entry = pointProgressResource(identity, team, 'stores')
    await entry.refresh(); await entry.settled()
    const requests = vi.mocked(requestJson).mock.calls.length
    notifyConfirmedWrite({ identityId: identity, path: '/api/raids/ride/presence', body: {} })
    expect(entry.state.status).toBe('ready')
    notifyConfirmedWrite({ identityId: identity, path: '/api/raids/ride/check-ins', body: {} })
    expect(entry.state.status).toBe('stale')
    expect(entry.state.data?.points[0]?.personalCount).toBe(0)
    expect(vi.mocked(requestJson).mock.calls.length).toBe(requests)
    await entry.settled()
    expect(await raidReadDb.snapshots.get(entry.key)).toBeUndefined()
  })
})
