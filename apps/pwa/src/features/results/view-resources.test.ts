import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { offlineDb } from '../offline/db'
import { activateIdentity, enqueueOperation } from '../offline/ledger'
import { raidReadDb, writeSnapshot } from '../raids/cache'
import { raidResource, resultResource, resetRaidResources, revalidateRaidSession, invalidatePointHistory } from '../raids/resources'
import { ApiError, requestJson } from '../../lib/http'
import { notifyConfirmedWrite } from '../../lib/api-events'
import { galleryResource, materialsResource, requestMoreView, COMPLETED_REFRESH_MS, completedPointsResource, visitHistoryResource } from './view-resources'
import { getRaidSnapshot } from '../raids/api'

vi.mock('../raids/api', () => ({ getRaidSnapshot: vi.fn(), getRaidMapPoints: vi.fn(), getRaid: vi.fn(), listActionableRaids: vi.fn() }))
vi.mock('../../lib/http', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/http')>(), requestJson: vi.fn() }))
const material = (id: string) => ({ id, pointSnapshotId: 'point', authorUserId: 'alice', authorName: 'Алиса', kind: 'comment', body: id,
  ready: true, width: null, height: null, createdAt: '2026-09-23T10:00:00Z' })
const photo = (id: string) => ({ id, state: 'ready', width: 100, height: 100, caption: id, createdAt: '2026-09-23T10:00:00Z' })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(async () => {
  resetRaidResources(); vi.resetAllMocks()
  await offlineDb.delete(); await offlineDb.open(); await raidReadDb.delete(); await raidReadDb.open()
  await activateIdentity('alice')
})
afterEach(() => { resetRaidResources(); vi.restoreAllMocks() })

describe('persistent view resources', () => {
  it('shares a nearby history warmup with a foreground open and retains it on reopen', async () => {
    const pending = deferred<any>()
    const load = vi.mocked(requestJson).mockReturnValue(pending.promise)
    const entry = visitHistoryResource('alice', 'team', 'point')
    const warmup = entry.refreshIfStale(COMPLETED_REFRESH_MS)
    const foreground = visitHistoryResource('alice', 'team', 'point').refreshIfStale(COMPLETED_REFRESH_MS)
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    pending.resolve({ personalCount: 0, visitors: [], entries: [], nextOffset: null })
    await Promise.all([warmup, foreground])
    await entry.refreshIfStale(COMPLETED_REFRESH_MS)
    expect(load).toHaveBeenCalledTimes(1)
    expect(entry.state.data?.visitors).toEqual([])
  })

  it('invalidates only changed team point histories including participant windows after a remote visit', async () => {
    const load = vi.mocked(requestJson).mockResolvedValue({ personalCount: 0, visitors: [], entries: [], nextOffset: null })
    const summary = visitHistoryResource('alice', 'team', 'point')
    const detail = visitHistoryResource('alice', 'team', 'point', 'alice')
    const otherPoint = visitHistoryResource('alice', 'team', 'other')
    const otherTeam = visitHistoryResource('alice', 'other-team', 'point')
    const denied = visitHistoryResource('alice', 'team', 'point', 'denied')
    await Promise.all([summary, detail, otherPoint, otherTeam].map(async entry => { await entry.refresh(); await entry.settled() }))
    denied.deny()
    const calls = load.mock.calls.length
    invalidatePointHistory('alice', 'team', new Set(['point']))
    await Promise.all([summary.settled(), detail.settled()])
    expect(summary.state.status).toBe('stale'); expect(detail.state.status).toBe('stale')
    expect(otherPoint.state.status).toBe('ready'); expect(otherTeam.state.status).toBe('ready')
    expect(denied.state.status).toBe('access-error')
    expect(await raidReadDb.snapshots.get(summary.key)).toBeUndefined()
    expect(await raidReadDb.snapshots.get(detail.key)).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(calls) // hidden windows do not start a request storm
    await summary.refreshIfStale(COMPLETED_REFRESH_MS)
    expect(load).toHaveBeenCalledTimes(calls + 1)
  })

  it('restores materials before a slow refresh and avoids requests on immediate reopen', async () => {
    const load = vi.mocked(requestJson).mockResolvedValue({ materials: [material('one')], nextCursor: null, canWrite: true })
    const entry = materialsResource('alice', 'team', 'raid', 'point')
    await entry.refresh(); await entry.settled()
    expect(materialsResource('alice', 'team', 'raid', 'point')).toBe(entry)
    await entry.refreshIfStale(COMPLETED_REFRESH_MS)
    expect(load).toHaveBeenCalledTimes(1)
    resetRaidResources()
    const restored = materialsResource('alice', 'team', 'raid', 'point')
    const pending = deferred<any>(); load.mockReturnValueOnce(pending.promise)
    const refresh = restored.refresh()
    await vi.waitFor(() => expect(restored.state.data?.items[0]?.body).toBe('one'))
    expect(restored.state.status).toBe('stale') // a saved canWrite is not authorization
    pending.resolve({ materials: [material('two')], nextCursor: null, canWrite: false })
    await refresh; await restored.settled()
    expect(restored.state.data?.items[0]?.body).toBe('two')
    expect(restored.state.data?.canWrite).toBe(false)
  })

  it('hydrates gallery depth before refreshing and retains its old tail after insertion', async () => {
    const load = vi.mocked(requestJson).mockImplementation(async path => String(path).includes('cursor=next')
      ? { media: [photo('old-tail')], nextCursor: null } as any : { media: [photo('first')], nextCursor: 'next' } as any)
    const entry = galleryResource('alice', 'team', 'raid')
    await entry.refresh(); await requestMoreView(entry); await entry.settled()
    expect(entry.state.data?.items).toHaveLength(2)
    resetRaidResources()
    const restored = galleryResource('alice', 'team', 'raid')
    load.mockImplementation(async path => String(path).includes('cursor=tail')
      ? { media: [photo('old-tail')], nextCursor: null } as any : String(path).includes('cursor=next')
      ? { media: [photo('first')], nextCursor: 'tail' } as any : { media: [photo('new')], nextCursor: 'next' } as any)
    await restored.refresh(); await restored.settled()
    expect(restored.state.data?.items.map(item => item.id)).toEqual(['new', 'first', 'old-tail'])
    expect(restored.state.data?.pageCount).toBe(3)
  })

  it('preserves a whole material window on later-page failure and retries the requested depth', async () => {
    const load = vi.mocked(requestJson).mockResolvedValue({ materials: [material('first')], nextCursor: 'next', canWrite: true })
    const entry = materialsResource('alice', 'team', 'raid', 'point')
    await entry.refresh()
    load.mockImplementation(async path => {
      if (String(path).includes('cursor=')) throw new Error('offline')
      return { materials: [material('new')], nextCursor: 'next', canWrite: true } as any
    })
    await requestMoreView(entry)
    expect(entry.state).toMatchObject({ status: 'stale', data: { items: [material('first')] } })
    load.mockImplementation(async path => (String(path).includes('cursor=')
      ? { materials: [material('first')], nextCursor: null, canWrite: true }
      : { materials: [material('new')], nextCursor: 'next', canWrite: true }) as any)
    await entry.refresh(); await entry.settled()
    expect(entry.state.data?.items.map(item => item.id)).toEqual(['new', 'first'])
  })

  it('fences late pre-write responses and invalidates disk for hidden views', async () => {
    const load = vi.mocked(requestJson).mockResolvedValue({ materials: [material('old')], nextCursor: null, canWrite: true })
    const entry = materialsResource('alice', 'team', 'raid', 'point')
    await entry.refresh(); await entry.settled()
    const old = deferred<any>(); load.mockReturnValueOnce(old.promise)
    const refresh = entry.refresh()
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    notifyConfirmedWrite({ identityId: 'alice', path: '/api/raids/raid/points/point/materials', body: { material: { id: 'new' } } })
    old.resolve({ materials: [material('old')], nextCursor: null, canWrite: true })
    await refresh; await entry.settled()
    expect(entry.state.status).toBe('stale')
    expect(await raidReadDb.snapshots.get(entry.key)).toBeUndefined()
    load.mockResolvedValue({ materials: [material('new')], nextCursor: null, canWrite: true })
    await entry.refresh(); await entry.settled()
    expect(entry.state.data?.items[0]?.id).toBe('new')
  })

  it('removes views on raid denial, including disk-only views, without deleting queued work', async () => {
    vi.mocked(requestJson).mockResolvedValue({ materials: [material('private')], nextCursor: null, canWrite: true })
    let entry = materialsResource('alice', 'team', 'raid', 'point')
    await entry.refresh(); await entry.settled()
    await enqueueOperation('check-in.submit', 'raid', {})
    resetRaidResources()
    const parent = raidResource('alice', 'raid')
    parent.deny(); await parent.settled()
    entry = materialsResource('alice', 'team', 'raid', 'point')
    await entry.hydrate()
    expect(entry.state.data).toBeNull()
    expect(entry.state.status).toBe('access-error')
    expect(await raidReadDb.snapshots.get(entry.key)).toBeUndefined()
    expect(await offlineDb.outbox.count()).toBe(1)
  })

  it('does not publish a previous identity response or restore another account’s snapshot', async () => {
    const old = deferred<any>(); const load = vi.mocked(requestJson).mockReturnValue(old.promise)
    const entry = materialsResource('alice', 'team', 'raid', 'point')
    const pending = entry.refresh()
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    await activateIdentity('bob'); resetRaidResources('bob')
    old.resolve({ materials: [material('private')], nextCursor: null, canWrite: true })
    await pending; await entry.settled()
    const bob = materialsResource('bob', 'team', 'raid', 'point'); await bob.hydrate()
    expect(entry.state.data).toBeNull(); expect(bob.state.data).toBeNull()
    expect(await raidReadDb.snapshots.count()).toBe(0)
  })

  it('gates writes on same-account renewal and clears on explicit material denial', async () => {
    const load = vi.mocked(requestJson).mockResolvedValue({ materials: [material('private')], nextCursor: null, canWrite: true })
    const entry = materialsResource('alice', 'team', 'raid', 'point')
    await entry.refresh(); await entry.settled()
    revalidateRaidSession('alice')
    expect(entry.state.status).toBe('stale')
    load.mockRejectedValue(new ApiError('FORBIDDEN', 'denied', 403))
    await entry.refresh(); await entry.settled()
    expect(entry.state).toMatchObject({ status: 'access-error', data: null })
    expect(await raidReadDb.snapshots.get(entry.key)).toBeUndefined()
  })

  it('rejects corrupt or cross-point disk data, expires snapshots and tolerates storage failure', async () => {
    const entry = materialsResource('alice', 'team', 'raid', 'point')
    await writeSnapshot({ key: entry.key, identityId: 'alice', kabandaId: 'team', savedAt: new Date().toISOString(),
      value: { items: [{ ...material('wrong'), pointSnapshotId: 'elsewhere' }], pageCount: 1, nextCursor: null, canWrite: true } }, () => true)
    await entry.hydrate(); expect(entry.state.data).toBeNull()
    vi.mocked(requestJson).mockResolvedValue({ materials: [material('valid')], nextCursor: null, canWrite: true })
    vi.spyOn(raidReadDb.snapshots, 'put').mockRejectedValueOnce(new Error('quota'))
    await entry.refresh(); await entry.settled()
    expect(entry.state.status).toBe('ready')
    expect(await raidReadDb.snapshots.get(entry.key)).toBeUndefined()
    await entry.refresh(); await entry.settled()
    resetRaidResources()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15 * 86_400_000)
    const expired = materialsResource('alice', 'team', 'raid', 'point')
    await expired.hydrate(); expect(expired.state.data).toBeNull()
  })

  it('persists authoritative empty lists and keeps raid and point-history keys separate', async () => {
    vi.mocked(requestJson).mockResolvedValue({ materials: [], nextCursor: null, canWrite: false })
    const a = materialsResource('alice', 'team', 'raid', 'point')
    const b = materialsResource('alice', 'team', 'another', 'point')
    expect(a.key).not.toBe(b.key)
    expect(visitHistoryResource('alice', 'team', 'one').key).not.toBe(visitHistoryResource('alice', 'team', 'two').key)
    await a.refresh(); await a.settled(); resetRaidResources()
    const restored = materialsResource('alice', 'team', 'raid', 'point')
    await restored.hydrate(); expect(restored.state.data?.items).toEqual([])
  })

  it('does not persist a snapshot whose raid context is wrong', async () => {
    vi.mocked(getRaidSnapshot).mockResolvedValue({ raid: { id: 'wrong' }, points: [] } as any)
    const entry = completedPointsResource('alice', 'team', 'raid')
    await entry.refresh(); await entry.settled()
    expect(entry.state.status).toBe('error')
    expect(await raidReadDb.snapshots.count()).toBe(0)
  })
})

it('does not hydrate or reauthorize a newly opened child while its result is denied', async () => {
  const parent = resultResource('alice', 'team', 'raid')
  parent.deny()
  const child = materialsResource('alice', 'team', 'raid', 'point')
  await child.hydrate(); await child.refresh(); await parent.settled(); await child.settled()
  expect(child.state).toMatchObject({ status: 'access-error', data: null })
  expect(requestJson).not.toHaveBeenCalled()
})

it('retains participant history depth and publishes all pages atomically after reload', async () => {
  const item = (id: string) => ({ id, raidId: id, title: id, state: 'completed', visitedAt: '2026-09-23T10:00:00Z', mine: true, personalVisits: 1,
    participants: [{ userId: 'alice', displayName: 'Алиса' }], visits: [{ id, userId: 'alice', displayName: 'Алиса', visitedAt: '2026-09-23T10:00:00Z', source: 'raid' }] })
  vi.mocked(requestJson).mockImplementation(async path => ({ visitors: [{ userId: 'alice', displayName: 'Алиса', count: 2 }], personalCount: 2,
    entries: [item(String(path).includes('offset=1') ? 'tail' : 'head')], nextOffset: String(path).includes('offset=1') ? null : 1 }) as any)
  const entry = visitHistoryResource('alice', 'team', 'point', 'alice')
  await entry.refresh(); await requestMoreView(entry); await entry.settled()
  resetRaidResources()
  const restored = visitHistoryResource('alice', 'team', 'point', 'alice')
  await restored.hydrate()
  expect(restored.state.data?.entries.map(row => row.id)).toEqual(['head', 'tail'])
  await restored.refresh(); await restored.settled()
  expect(restored.state.data?.pageCount).toBe(2)
})

it('bounds view snapshots without evicting operational queues or ordinary raid cards', async () => {
  await enqueueOperation('check-in.submit', 'raid', {})
  for (let i = 0; i < 153; i++) await writeSnapshot({ key: JSON.stringify(['alice', 'raid', 'raid-view', { i }]), identityId: 'alice', kabandaId: 'team',
    savedAt: new Date(Date.now() + i).toISOString(), value: { i } }, () => true)
  expect(await raidReadDb.snapshots.count()).toBe(150)
  expect(await offlineDb.outbox.count()).toBe(1)
})
