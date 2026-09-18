import 'fake-indexeddb/auto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { offlineDb } from '../offline/db'
import { activateIdentity, enqueueOperation } from '../offline/ledger'
import { raidReadDb } from './cache'
import { raidResource, resetRaidResources } from './resources'
import type { RaidProjection } from './types'

vi.mock('./api', () => ({ listActionableRaids: vi.fn(), getRaid: vi.fn() }))
vi.mock('../results/api', () => ({ listRaidHistory: vi.fn(), getKabandaProgress: vi.fn() }))
import { getRaid } from './api'

const raid: RaidProjection = {
  id: 'ride', kabandaId: 'crew', title: 'Рейд', state: 'active', version: 4,
  scheduledAt: null, description: null, organizerUserId: 'user', navigatorUserId: 'user',
  navigatorReady: true, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null },
  participants: [{ id: 'user', displayName: 'Тест', avatarUrl: null, state: 'active' }], allowedActions: ['pause'],
}

beforeEach(async () => {
  resetRaidResources(); vi.resetAllMocks()
  await offlineDb.delete(); await offlineDb.open()
  await raidReadDb.delete(); await raidReadDb.open()
  await activateIdentity('user')
  vi.mocked(getRaid).mockResolvedValue(raid)
})
afterEach(() => resetRaidResources())

describe('offline identity bootstrap', () => {
  it('keeps the cached consumer refreshable after the first online identity confirmation', async () => {
    const entry = raidResource('user', raid.id)
    entry.accept(raid, true, 'stale')
    await entry.settled()
    await enqueueOperation('check-in.submit', raid.id, { synthetic: true })

    // /me first succeeds only AFTER the offline-mounted detail has subscribed.
    resetRaidResources('user')
    expect(raidResource('user', raid.id)).toBe(entry)
    expect(entry.state.status).toBe('stale')
    await entry.refresh(); await entry.settled()
    expect(entry.state).toMatchObject({ data: raid, status: 'ready' })
    expect(await offlineDb.outbox.count()).toBe(1)
  })

  it('retires foreign consumers and fences their late replies during confirmation', async () => {
    const old = raidResource('other-user', raid.id)
    let resolve!: (value: RaidProjection) => void
    vi.mocked(getRaid).mockReturnValueOnce(new Promise(done => { resolve = done }))
    const pending = old.refresh()
    await vi.waitFor(() => expect(getRaid).toHaveBeenCalledTimes(1))
    const current = raidResource('user', raid.id)
    current.accept(raid, false, 'stale')

    resetRaidResources('user')
    resolve(raid)
    await pending; await old.settled()
    expect(old.state.data).toBeNull()
    expect(raidResource('user', raid.id)).toBe(current)
    await current.refresh(); await current.settled()
    expect(current.state.status).toBe('ready')
    expect(await raidReadDb.snapshots.where('identityId').equals('other-user').count()).toBe(0)
  })
})
