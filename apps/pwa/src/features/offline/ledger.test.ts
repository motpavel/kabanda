import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { offlineDb } from './db'
import {
  activateIdentity,
  canReplayOperation,
  clearActiveIdentity,
  enqueueOperation,
  getReplayBatch,
} from './ledger'
import type { OutboxOperation } from './types'

const operation: OutboxOperation = {
  id: 'operation-1',
  identityId: 'user-a',
  kind: 'route.sample',
  aggregateId: 'raid-1',
  payload: {},
  createdAt: '2026-08-28T05:00:00.000Z',
  status: 'pending',
  attempts: 0,
}

describe('identity-bound outbox', () => {
  beforeEach(async () => {
    await offlineDb.delete()
    await offlineDb.open()
  })

  afterEach(async () => {
    await offlineDb.delete()
  })

  it('replays an operation only for the active identity', () => {
    expect(canReplayOperation(operation, 'user-a')).toBe(true)
    expect(canReplayOperation(operation, 'user-b')).toBe(false)
  })

  it('does not select an operation already being sent', () => {
    expect(canReplayOperation({ ...operation, status: 'sending' }, 'user-a')).toBe(false)
  })

  it('does not enqueue or replay the previous account after an account switch', async () => {
    await activateIdentity('user-a')
    const operationA = await enqueueOperation('route.sample', 'raid-a', {})

    await activateIdentity('user-b')
    const operationB = await enqueueOperation('route.sample', 'raid-b', {})

    expect(operationA.identityId).toBe('user-a')
    expect(operationB.identityId).toBe('user-b')
    expect(await getReplayBatch('user-a')).toEqual([])
    expect((await getReplayBatch('user-b')).map(({ id }) => id)).toEqual([operationB.id])

    await clearActiveIdentity()
    await expect(enqueueOperation('route.sample', 'raid-c', {})).rejects.toThrow(
      'Active identity is required before enqueue',
    )
  })

  it('preserves pending work across logout but replays it only after the same user returns', async () => {
    await activateIdentity('user-a')
    const pending = await enqueueOperation('route.sample', 'raid-a', {})

    await clearActiveIdentity()
    expect(await getReplayBatch('user-a')).toEqual([])

    await activateIdentity('user-a')
    expect((await getReplayBatch('user-a')).map(({ id }) => id)).toEqual([pending.id])
  })

  it('does not let failed operations starve a new pending operation', async () => {
    await activateIdentity('user-a')
    const failed = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        enqueueOperation('route.sample', `failed-${index}`, {}),
      ),
    )
    await offlineDb.outbox.bulkPut(failed.map((item) => ({ ...item, status: 'failed' })))
    const pending = await enqueueOperation('route.sample', 'pending', {})

    const batch = await getReplayBatch('user-a', 50)
    expect(batch).toHaveLength(50)
    expect(batch[0]?.id).toBe(pending.id)
  })
})
