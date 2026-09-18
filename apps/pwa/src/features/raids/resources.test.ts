import 'fake-indexeddb/auto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { offlineDb } from '../offline/db'
import { activateIdentity, enqueueOperation } from '../offline/ledger'
import { ApiError } from '../../lib/http'
import { notifyConfirmedWrite } from '../../lib/api-events'
import { raidReadDb, readActionableRaidProjections, readRaidProjection, saveRaidProjection } from './cache'
import { actionableResource, raidResource, historyResource, resetRaidResources } from './resources'
import type { RaidProjection } from './types'
vi.mock('./api', () => ({ listActionableRaids: vi.fn(), getRaid: vi.fn() }))
vi.mock('../results/api', () => ({ listRaidHistory: vi.fn(), getKabandaProgress: vi.fn() }))
import { listActionableRaids, getRaid } from './api'
import { listRaidHistory } from '../results/api'

const raid: RaidProjection = {
  id: 'ride', kabandaId: 'crew', title: 'Рейд', state: 'lobby', version: 4,
  scheduledAt: null, description: null, organizerUserId: 'user', navigatorUserId: 'user',
  navigatorReady: false, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null },
  participants: [{ id: 'user', displayName: 'Тест', avatarUrl: null, state: 'invited' }], allowedActions: ['accept'],
}
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const confirm = (next: RaidProjection, path = '/api/raids/ride/readiness') => notifyConfirmedWrite({ identityId: 'user', path, body: { raid: next } })

beforeEach(async () => {
  resetRaidResources()
  vi.resetAllMocks()
  await offlineDb.delete(); await offlineDb.open()
  await raidReadDb.delete(); await raidReadDb.open()
  await activateIdentity('user')
  vi.mocked(listActionableRaids).mockResolvedValue([raid])
  vi.mocked(getRaid).mockResolvedValue(raid)
  vi.mocked(listRaidHistory).mockResolvedValue({ raids: [], nextCursor: null })
})
afterEach(async () => { resetRaidResources(); vi.restoreAllMocks() })

describe('shared raid resources and persisted membership', () => {
  it('persists a confirmed empty list without deleting cards or queued work', async () => {
    await saveRaidProjection('user', raid)
    await enqueueOperation('check-in.submit', raid.id, { synthetic: true })
    const list = actionableResource('user', 'crew')
    vi.mocked(listActionableRaids).mockResolvedValue([])
    await list.refresh(); await list.settled()
    expect(await readActionableRaidProjections('user', 'crew')).toEqual([])
    expect((await readRaidProjection('user', raid.id))?.raid.state).toBe('lobby')
    expect(await offlineDb.outbox.count()).toBe(1)
    resetRaidResources()
    const restored = actionableResource('user', 'crew')
    await restored.hydrate()
    expect(restored.state).toMatchObject({ data: [], status: 'stale' })
  })

  it('does not reconstruct unknown membership from legacy active cards', async () => {
    await saveRaidProjection('user', raid)
    expect(await readActionableRaidProjections('user', 'crew')).toBeNull()
  })

  it('ignores late list and detail reads after an equal-version readiness/participant command', async () => {
    const list = actionableResource('user', 'crew'), detail = raidResource('user', raid.id)
    await list.refresh(); await list.settled()
    const oldList = deferred<RaidProjection[]>(), oldDetail = deferred<RaidProjection>()
    vi.mocked(listActionableRaids).mockReturnValue(oldList.promise)
    vi.mocked(getRaid).mockReturnValue(oldDetail.promise)
    const a = list.refresh(), b = detail.refresh()
    const next = { ...raid, navigatorReady: true, participants: [{ ...raid.participants[0]!, state: 'accepted' as const }] }
    confirm(next)
    oldList.resolve([raid]); oldDetail.resolve(raid)
    await Promise.all([a, b, list.settled(), detail.settled()])
    expect(list.state.data?.[0]?.navigatorReady).toBe(true)
    expect(detail.state.data?.participants[0]?.state).toBe('accepted')
    expect((await readActionableRaidProjections('user', 'crew'))?.[0]?.raid.navigatorReady).toBe(true)
    expect((await readRaidProjection('user', raid.id))?.raid.navigatorReady).toBe(true)
  })

  it('fences a list still unknown when a command is confirmed', async () => {
    const old = deferred<RaidProjection[]>()
    vi.mocked(listActionableRaids).mockReturnValue(old.promise)
    const list = actionableResource('user', 'crew'), request = list.refresh()
    confirm({ ...raid, state: 'completed', version: 5 })
    old.resolve([raid]); await request
    expect(list.state.data).toBeNull()
    expect((await readRaidProjection('user', raid.id))?.raid.state).not.toBe('lobby')
  })

  it('fences slow IndexedDB hydration when a server response wins', async () => {
    const old = deferred<unknown>()
    vi.spyOn(raidReadDb.snapshots, 'get').mockImplementation(() => old.promise as ReturnType<typeof raidReadDb.snapshots.get>)
    const list = actionableResource('user', 'crew')
    const local = list.hydrate()
    vi.mocked(listActionableRaids).mockResolvedValue([])
    await list.refresh()
    old.resolve({ identityId: 'user', value: [raid], savedAt: '2026-09-18T00:00:00Z' })
    await local
    expect(list.state).toMatchObject({ data: [], status: 'ready' })
  })

  it('keeps canonical data and removes older disk membership on quota failure', async () => {
    const list = actionableResource('user', 'crew')
    await list.refresh(); await list.settled()
    vi.spyOn(raidReadDb.snapshots, 'put').mockRejectedValue(new DOMException('full', 'QuotaExceededError'))
    vi.mocked(listActionableRaids).mockResolvedValue([])
    await list.refresh(); await list.settled()
    expect(list.state).toMatchObject({ data: [], status: 'ready', message: null })
    expect(await readActionableRaidProjections('user', 'crew')).toBeNull()
  })

  it('does not deliver a retired identity response or mix team/query pages', async () => {
    const old = deferred<RaidProjection[]>()
    vi.mocked(listActionableRaids).mockReturnValueOnce(old.promise)
    const previous = actionableResource('user', 'crew'), request = previous.refresh()
    resetRaidResources(); await activateIdentity('other')
    const next = actionableResource('other', 'crew')
    old.resolve([raid]); await request; await previous.settled()
    expect(previous.state.data).toBeNull(); expect(next.state.data).toBeNull()
    expect(await raidReadDb.snapshots.count()).toBe(0)
    expect(historyResource('other', 'crew', 12).key).not.toBe(historyResource('other', 'crew', 12, 'page2').key)
    expect(actionableResource('other', 'crew2').key).not.toBe(next.key)
  })

  it('revokes scoped content and prevents offline resurrection without touching queues', async () => {
    const list = actionableResource('user', 'crew')
    await list.refresh(); await list.settled(); await raidResource('user', raid.id).settled()
    await enqueueOperation('check-in.submit', raid.id, {})
    vi.mocked(listActionableRaids).mockRejectedValue(new ApiError('FORBIDDEN', 'denied', 403))
    await list.refresh(); await list.settled(); await raidResource('user', raid.id).settled()
    expect(list.state.status).toBe('access-error')
    expect(raidResource('user', raid.id).state.data).toBeNull()
    expect(await readActionableRaidProjections('user', 'crew')).toBeNull()
    expect(await readRaidProjection('user', raid.id)).toBeNull()
    expect(await offlineDb.outbox.count()).toBe(1)
  })

  it('updates completed membership and fetches history without calculating results', async () => {
    const list = actionableResource('user', 'crew'), history = historyResource('user', 'crew')
    await list.refresh(); await history.refresh()
    const calls = vi.mocked(listRaidHistory).mock.calls.length
    confirm({ ...raid, state: 'completed', version: 5 })
    await history.refresh(); await list.settled()
    expect(list.state.data).toEqual([])
    expect(vi.mocked(listRaidHistory).mock.calls.length).toBe(calls + 1)
    expect(await readActionableRaidProjections('user', 'crew')).toEqual([])
  })

  it('removes a confirmed decline from memory and the persisted actionable snapshot', async () => {
    const list = actionableResource('user', 'crew')
    await list.refresh(); await list.settled()
    confirm({ ...raid, organizerUserId: 'organizer', participants: [{ ...raid.participants[0]!, state: 'declined' }], allowedActions: [] },
      '/api/raids/ride/participants/me/decline')
    await list.settled()
    expect(list.state.data).toEqual([])
    expect(await readActionableRaidProjections('user', 'crew')).toEqual([])
  })
})
