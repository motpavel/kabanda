import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestJson } from '../../lib/http'
import { offlineDb } from '../offline/db'
import { activateIdentity, enqueueOperation } from '../offline/ledger'
import { raidReadDb } from '../raids/cache'
import { actionableResource, raidResource, resetRaidResources, resultResource, revalidateRaidSession } from '../raids/resources'
import { saveRaidResult } from './cache'
import type { RaidResult } from './types'

vi.mock('../../lib/http', async original => ({ ...await original<typeof import('../../lib/http')>(), requestJson: vi.fn() }))
const identity = '11111111-1111-4111-8111-111111111111'
const team = '22222222-2222-4222-8222-222222222222'
const raid = '33333333-3333-4333-8333-333333333333'
const metrics = { durationSeconds: 600, distanceMeters: 1500, uniquePoints: 2, photos: 0 }
const result: RaidResult = {
  schemaVersion: 1, raid: { id: raid, kabandaId: team, title: 'Завершённый рейд',
    startedAt: '2026-09-18T12:00:00Z', completedAt: '2026-09-18T12:10:00Z', partial: false },
  personal: metrics, team: metrics, participants: [{ userId: identity, displayName: 'Участник', metrics }],
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
beforeEach(async () => {
  resetRaidResources(); vi.clearAllMocks()
  vi.stubGlobal('navigator', { onLine: true })
  await offlineDb.delete(); await offlineDb.open()
  await raidReadDb.delete(); await raidReadDb.open()
  await activateIdentity(identity)
})
afterEach(() => { resetRaidResources(); vi.unstubAllGlobals() })

describe('completed result shares the common read lifecycle', () => {
  it('coalesces reads and keeps results for different raids isolated', async () => {
    vi.mocked(requestJson).mockResolvedValue({ result })
    const entry = resultResource(identity, team, raid)
    await Promise.all([entry.refresh(), entry.refresh()]); await entry.settled()
    expect(requestJson).toHaveBeenCalledTimes(1)
    expect(entry.state).toMatchObject({ status: 'ready', data: result })
    expect(resultResource(identity, team, raid)).toBe(entry)
    expect(resultResource(identity, team, 'another-raid').key).not.toBe(entry.key)
    expect(resultResource('other-user', team, raid).key).not.toBe(entry.key)
    expect(resultResource(identity, 'other-team', raid).key).not.toBe(entry.key)
    expect((await raidReadDb.snapshots.get(entry.key))?.value).toEqual(result)
  })

  it.each([true, false])('retains a cached result after failure with online=%s, then confirms it on retry', async online => {
    vi.stubGlobal('navigator', { onLine: online })
    await saveRaidResult(identity, result)
    const entry = resultResource(identity, team, raid)
    await entry.hydrate()
    expect(entry.state).toMatchObject({ status: 'stale', data: result })
    vi.mocked(requestJson).mockRejectedValue(new TypeError('connection failed'))
    await entry.refresh()
    expect(entry.state).toMatchObject({ status: 'stale', data: result,
      message: online ? 'Не удалось обновить данные.' : 'Нет соединения. Показана сохранённая копия.' })
    vi.stubGlobal('navigator', { onLine: true })
    vi.mocked(requestJson).mockResolvedValue({ result })
    await entry.refresh(); await entry.settled()
    expect(entry.state).toMatchObject({ status: 'ready', data: result, message: null })
  })

  it.each([401, 403, 404])('a %s deletes both old and new result snapshots without touching an outbox', async status => {
    await saveRaidResult(identity, result)
    const operation = await enqueueOperation('check-in.submit', raid, { synthetic: true })
    vi.mocked(requestJson).mockResolvedValue({ result })
    const entry = resultResource(identity, team, raid)
    await entry.refresh(); await entry.settled()
    expect(await offlineDb.raidResults.count()).toBe(1)
    vi.mocked(requestJson).mockRejectedValue(new ApiError('DENIED', 'denied', status))
    await entry.refresh(); await entry.settled()
    expect(entry.state).toMatchObject({ status: 'access-error', data: null })
    expect(await offlineDb.raidResults.count()).toBe(0)
    expect(await raidReadDb.snapshots.get(entry.key)).toBeUndefined()
    expect(await offlineDb.outbox.get(operation.id)).toEqual(operation)
    resetRaidResources()
    const reopened = resultResource(identity, team, raid)
    await reopened.hydrate()
    expect(reopened.state.data).toBeNull()
  })

  it.each(['team', 'raid'] as const)('a %s denial fences an already requested result response', async scope => {
    const delayed = deferred<{ result: RaidResult }>()
    vi.mocked(requestJson).mockImplementation(async path => {
      if (String(path).endsWith('/result')) return delayed.promise
      throw new ApiError('DENIED', 'denied', 403)
    })
    const entry = resultResource(identity, team, raid)
    const pending = entry.refresh()
    await vi.waitFor(() => expect(requestJson).toHaveBeenCalledTimes(1))
    const authority = scope === 'team' ? actionableResource(identity, team, 'member') : raidResource(identity, raid)
    await authority.refresh(); await authority.settled()
    delayed.resolve({ result })
    await pending; await entry.settled()
    expect(entry.state).toMatchObject({ status: 'access-error', data: null })
    expect(await raidReadDb.snapshots.get(entry.key)).toBeUndefined()
  })

  it('retires a late result when identity changes', async () => {
    const delayed = deferred<{ result: RaidResult }>()
    vi.mocked(requestJson).mockReturnValue(delayed.promise)
    const entry = resultResource(identity, team, raid)
    const pending = entry.refresh()
    await vi.waitFor(() => expect(requestJson).toHaveBeenCalledTimes(1))
    resetRaidResources('new-user'); await activateIdentity('new-user')
    delayed.resolve({ result })
    await pending; await entry.settled()
    expect(entry.state.data).toBeNull()
    expect(await raidReadDb.snapshots.count()).toBe(0)
  })

  it('ignores an old-session rejection after a newer same-user result succeeds', async () => {
    const delayed = deferred<{ result: RaidResult }>()
    vi.mocked(requestJson).mockReturnValueOnce(delayed.promise).mockResolvedValueOnce({ result })
    const entry = resultResource(identity, team, raid)
    const old = entry.refresh()
    await vi.waitFor(() => expect(requestJson).toHaveBeenCalledTimes(1))
    revalidateRaidSession(identity)
    await entry.refresh(); await entry.settled()
    delayed.reject(new ApiError('OLD_SESSION', 'old session', 401))
    await old; await entry.settled()
    expect(entry.state).toMatchObject({ status: 'ready', data: result })
    expect((await raidReadDb.snapshots.get(entry.key))?.value).toEqual(result)
  })

  it.each(['raid', 'team', 'metrics'] as const)('rejects a network response with invalid %s context', async field => {
    const wrong = structuredClone(result)
    if (field === 'raid') wrong.raid.id = 'another-raid'
    if (field === 'team') wrong.raid.kabandaId = 'another-team'
    if (field === 'metrics') wrong.personal.distanceMeters = -1
    vi.mocked(requestJson).mockResolvedValue({ result: wrong })
    const entry = resultResource(identity, team, raid)
    await entry.refresh(); await entry.settled()
    expect(entry.state).toMatchObject({ status: 'error', data: null })
    expect(await raidReadDb.snapshots.count()).toBe(0)
  })

  it('does not hydrate a well-formed result saved under a foreign team context', async () => {
    const entry = resultResource(identity, team, raid)
    await raidReadDb.snapshots.put({ key: entry.key, identityId: identity, kabandaId: team,
      savedAt: '2026-09-18T12:10:00Z', value: { ...result, raid: { ...result.raid, kabandaId: 'another-team' } } })
    await entry.hydrate()
    expect(entry.state.data).toBeNull()
  })
})
