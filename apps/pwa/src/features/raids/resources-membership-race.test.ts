import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { offlineDb } from '../offline/db'
import { activateIdentity, enqueueOperation } from '../offline/ledger'
import { ApiError } from '../../lib/http'
import { notifyConfirmedWrite } from '../../lib/api-events'
import { raidReadDb, readActionableRaidProjections, readRaidProjection } from './cache'
import { actionableResource, raidResource, resetRaidResources } from './resources'
import type { RaidProjection } from './types'

vi.mock('./api', () => ({ listActionableRaids: vi.fn(), getRaid: vi.fn() }))
vi.mock('../results/api', () => ({ listRaidHistory: vi.fn(), getKabandaProgress: vi.fn() }))
import { getRaid, listActionableRaids } from './api'

const raid: RaidProjection = {
  id: 'ride', kabandaId: 'crew', title: 'Рейд', state: 'lobby', version: 4,
  scheduledAt: null, description: null, organizerUserId: 'organizer', navigatorUserId: 'organizer',
  navigatorReady: false, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null },
  participants: [{ id: 'user', displayName: 'Тест', avatarUrl: null, state: 'accepted' }], allowedActions: ['leave'],
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
  vi.mocked(listActionableRaids).mockResolvedValue([])
  vi.mocked(getRaid).mockResolvedValue(raid)
})
afterEach(() => { resetRaidResources(); vi.restoreAllMocks() })

describe('confirmed membership before list revalidation', () => {
  it('adds an accepted raid to a known empty list before the next list response', async () => {
    const list = actionableResource('user', 'crew', 'member')
    await list.refresh(); await list.settled()
    const nextRead = deferred<RaidProjection[]>()
    vi.mocked(listActionableRaids).mockReturnValue(nextRead.promise)
    try {
      notifyConfirmedWrite({ identityId: 'user', path: '/api/raids/ride/participants/me/accept', body: { raid } })
      expect(list.state).toMatchObject({ status: 'ready', data: [raid] })
      await list.settled()
      expect((await readActionableRaidProjections('user', 'crew'))?.map(item => item.raid)).toEqual([raid])
    } finally {
      nextRead.resolve([raid])
      await list.refresh(); await list.settled(); await raidResource('user', raid.id).settled()
    }
  })

  it('does not turn one confirmed card into an authoritative list when membership is unknown', async () => {
    const list = actionableResource('user', 'crew', 'member')
    const nextRead = deferred<RaidProjection[]>()
    vi.mocked(listActionableRaids).mockReturnValue(nextRead.promise)
    try {
      notifyConfirmedWrite({ identityId: 'user', path: '/api/raids/ride/participants/me/accept', body: { raid } })
      expect(list.state.data).toBeNull()
      await list.settled()
      expect(await readActionableRaidProjections('user', 'crew')).toBeNull()
    } finally {
      nextRead.resolve([raid])
      await list.refresh(); await list.settled(); await raidResource('user', raid.id).settled()
    }
  })

  it('does not add a declined member raid to a known empty list', async () => {
    const list = actionableResource('user', 'crew', 'member')
    await list.refresh(); await list.settled()
    const declined: RaidProjection = { ...raid, participants: [{ ...raid.participants[0]!, state: 'declined' }], allowedActions: [] }
    notifyConfirmedWrite({ identityId: 'user', path: '/api/raids/ride/readiness', body: { raid: declined } })
    expect(list.state.data).toEqual([])
    await list.settled(); await raidResource('user', raid.id).settled()
    expect(await readActionableRaidProjections('user', 'crew')).toEqual([])
  })
})

describe('revocation while the first detail response is in flight', () => {
  it('never exposes or persists a late first detail after its team has been denied', async () => {
    await enqueueOperation('check-in.submit', raid.id, { synthetic: true })
    const detail = raidResource('user', raid.id)
    expect(detail.kabandaId).toBe('')
    const oldRead = deferred<RaidProjection>()
    vi.mocked(getRaid).mockReturnValueOnce(oldRead.promise)
    const pending = detail.refresh()
    const list = actionableResource('user', 'crew', 'member')
    vi.mocked(listActionableRaids).mockRejectedValue(new ApiError('FORBIDDEN', 'denied', 403))
    await list.refresh(); await list.settled()
    expect(list.state.status).toBe('access-error')
    oldRead.resolve(raid)
    await pending; await detail.settled(); await list.settled()
    expect(detail.state).toMatchObject({ data: null, status: 'access-error' })
    expect(await readRaidProjection('user', raid.id)).toBeNull()
    expect(await raidReadDb.snapshots.get(detail.key)).toBeUndefined()
    expect(list.state.status).toBe('access-error')
    expect(await offlineDb.outbox.count()).toBe(1)

    // A genuinely NEW read can confirm re-granted access; a denial is not permanent.
    vi.mocked(getRaid).mockResolvedValue(raid)
    await detail.refresh(); await detail.settled()
    expect(detail.state).toMatchObject({ data: raid, status: 'ready' })
    expect(await offlineDb.outbox.count()).toBe(1)
  })

  it('does not discard an unrelated team first detail because another team was denied', async () => {
    const other: RaidProjection = { ...raid, id: 'other-ride', kabandaId: 'other-crew' }
    const detail = raidResource('user', other.id)
    const oldRead = deferred<RaidProjection>()
    vi.mocked(getRaid).mockReturnValueOnce(oldRead.promise)
    const pending = detail.refresh()
    const list = actionableResource('user', 'crew', 'member')
    vi.mocked(listActionableRaids).mockRejectedValue(new ApiError('FORBIDDEN', 'denied', 403))
    await list.refresh(); await list.settled()
    oldRead.resolve(other)
    await pending; await detail.settled()
    expect(detail.state).toMatchObject({ data: other, status: 'ready' })
  })
})
