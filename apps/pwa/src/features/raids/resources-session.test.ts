import 'fake-indexeddb/auto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { offlineDb } from '../offline/db'
import { activateIdentity, enqueueOperation } from '../offline/ledger'
import { ApiError } from '../../lib/http'
import { raidReadDb, readActionableRaidProjections } from './cache'
import { actionableResource, raidResource, resetRaidResources, revalidateRaidSession } from './resources'
import type { RaidProjection } from './types'

vi.mock('./api', () => ({ listActionableRaids: vi.fn(), getRaid: vi.fn() }))
vi.mock('../results/api', () => ({ listRaidHistory: vi.fn(), getKabandaProgress: vi.fn() }))
import { listActionableRaids, getRaid } from './api'

const raid: RaidProjection = {
  id: 'ride', kabandaId: 'crew', title: 'Рейд', state: 'lobby', version: 4,
  scheduledAt: null, description: null, organizerUserId: 'organizer', navigatorUserId: null,
  navigatorReady: false, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null },
  participants: [{ id: 'user', displayName: 'Тест', avatarUrl: null, state: 'invited' }], allowedActions: ['accept'],
}
const accepted: RaidProjection = {
  ...raid, participants: [{ ...raid.participants[0]!, state: 'accepted' }], allowedActions: ['ready'],
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(async () => {
  resetRaidResources()
  vi.resetAllMocks()
  await offlineDb.delete(); await offlineDb.open()
  await raidReadDb.delete(); await raidReadDb.open()
  await activateIdentity('user')
  vi.mocked(listActionableRaids).mockResolvedValue([raid])
  vi.mocked(getRaid).mockResolvedValue(raid)
})
afterEach(() => { resetRaidResources(); vi.restoreAllMocks() })

describe('same-account session renewal', () => {
  it('keeps the subscribed resource instance and gates actions until the API confirms it', async () => {
    const list = actionableResource('user', 'crew', 'member')
    await list.refresh(); await list.settled(); await raidResource('user', raid.id).settled()
    const release = list.retainActiveReader()
    const fresh = deferred<RaidProjection[]>()
    vi.mocked(listActionableRaids).mockReturnValue(fresh.promise)

    revalidateRaidSession('user')
    expect(actionableResource('user', 'crew', 'member')).toBe(list)
    expect(list.state).toMatchObject({ status: 'stale', data: [raid] })
    const pending = list.refresh()
    fresh.resolve([accepted])
    await pending; await list.settled(); await raidResource('user', raid.id).settled()

    expect(list.state).toMatchObject({ status: 'ready', data: [accepted] })
    expect((await readActionableRaidProjections('user', 'crew'))?.[0]?.raid).toEqual(accepted)
    release()
  })

  it('does not let an old-session response replace the renewed empty list or disk snapshot', async () => {
    const list = actionableResource('user', 'crew', 'member')
    await list.refresh(); await list.settled(); await raidResource('user', raid.id).settled()
    const release = list.retainActiveReader()
    const old = deferred<RaidProjection[]>()
    vi.mocked(listActionableRaids).mockReturnValueOnce(old.promise)
    const previousRequest = list.refresh()
    await vi.waitFor(() => expect(listActionableRaids).toHaveBeenCalledTimes(2))

    vi.mocked(listActionableRaids).mockResolvedValue([])
    revalidateRaidSession('user')
    await list.refresh(); await list.settled()
    old.resolve([raid])
    await previousRequest; await list.settled()

    expect(list.state).toMatchObject({ status: 'ready', data: [] })
    expect(await readActionableRaidProjections('user', 'crew')).toEqual([])
    release()
  })

  it('marks hidden resources stale without starting background reads; they remain refreshable', async () => {
    const list = actionableResource('user', 'crew', 'member')
    await list.refresh(); await list.settled(); await raidResource('user', raid.id).settled()
    const release = list.retainActiveReader()
    release(); release() // StrictMode/unmount cleanup must be harmless when repeated.
    const calls = vi.mocked(listActionableRaids).mock.calls.length

    revalidateRaidSession('user')
    await Promise.resolve()
    expect(listActionableRaids).toHaveBeenCalledTimes(calls)
    expect(list.state.status).toBe('stale')
    expect(actionableResource('user', 'crew', 'member')).toBe(list)

    vi.mocked(listActionableRaids).mockResolvedValue([accepted])
    await list.refresh(); await list.settled(); await raidResource('user', raid.id).settled()
    expect(list.state.data).toEqual([accepted])
    expect(list.state.status).toBe('ready')
  })

  it('honors revoked permissions after renewal without deleting pending operations', async () => {
    const list = actionableResource('user', 'crew', 'member')
    await list.refresh(); await list.settled(); await raidResource('user', raid.id).settled()
    await enqueueOperation('check-in.submit', raid.id, { synthetic: true })
    const release = list.retainActiveReader()
    vi.mocked(listActionableRaids).mockRejectedValue(new ApiError('FORBIDDEN', 'denied', 403))

    revalidateRaidSession('user')
    await list.refresh(); await list.settled(); await raidResource('user', raid.id).settled()
    expect(list.state).toMatchObject({ status: 'access-error', data: null })
    expect(raidResource('user', raid.id).state.data).toBeNull()
    expect(await readActionableRaidProjections('user', 'crew')).toBeNull()
    expect(await offlineDb.outbox.count()).toBe(1)
    release()
  })
})
