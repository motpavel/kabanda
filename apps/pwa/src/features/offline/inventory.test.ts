import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { offlineDb } from './db'
import { activateIdentity } from './ledger'
import { getIdentityLocalInventory } from './inventory'

describe('identity-bound local inventory before logout', () => {
  beforeEach(async () => {
    await offlineDb.delete()
    await offlineDb.open()
  })

  afterEach(async () => {
    await offlineDb.delete()
  })

  it('counts only unfinished work owned by the active identity', async () => {
    await activateIdentity('user-a')
    await offlineDb.outbox.bulkAdd([
      { id: 'legacy-a', identityId: 'user-a', status: 'failed' },
      { id: 'legacy-b', identityId: 'user-b', status: 'pending' },
    ] as never[])
    await offlineDb.routeOutbox.bulkAdd([
      { id: 'route-a', identityId: 'user-a', status: 'retryable' },
      { id: 'route-done', identityId: 'user-a', status: 'accepted' },
    ] as never[])
    await offlineDb.recorderSessions.add({ key: 'recording-a', identityId: 'user-a', wanted: true } as never)
    await offlineDb.checkInOutbox.bulkAdd([
      { operationId: 'check-a', identityId: 'user-a', status: 'pending' },
      { operationId: 'check-action', identityId: 'user-a', status: 'needs_action' },
    ] as never[])
    await offlineDb.mediaDrafts.bulkAdd([
      { operationId: 'media-a', identityId: 'user-a', status: 'local' },
      { operationId: 'media-rejected', identityId: 'user-a', status: 'rejected' },
    ] as never[])

    expect(await getIdentityLocalInventory('user-a')).toEqual({
      activeRecordings: 1,
      routePending: 1,
      checkInsPending: 1,
      mediaPending: 1,
      needsAction: 2,
      legacyPending: 1,
      total: 7,
    })
  })

  it('does not expose the previous account inventory after an account switch', async () => {
    await activateIdentity('user-a')
    await offlineDb.outbox.add({ id: 'legacy-a', identityId: 'user-a', status: 'pending' } as never)
    await activateIdentity('user-b')

    expect(await getIdentityLocalInventory('user-a')).toBeNull()
    expect((await getIdentityLocalInventory('user-b'))?.total).toBe(0)
  })
})
