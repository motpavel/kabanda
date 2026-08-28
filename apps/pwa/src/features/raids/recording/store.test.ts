import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { offlineDb } from '../../offline/db'
import { activateIdentity } from '../../offline/ledger'
import type { RouteBatchResponse } from '../types'
import {
  acquireWriterLease,
  claimRouteBatch,
  getOrCreateRecorderSession,
  getOrCreateRouteLeaseAttempt,
  completeRouteLeaseAttempt,
  markRouteBatchRetryable,
  persistRouteSample,
  settleRouteBatch,
  WRITER_LEASE_TTL_MS,
} from './store'
import type { CapturedRouteSample, RecorderContext } from './types'

const context: RecorderContext = {
  identityId: 'user-a',
  kabandaId: 'kabanda-a',
  raidId: 'raid-a',
  navigatorLeaseId: 'lease-a',
  leaseGeneration: 1,
}

const sample = (index: number): CapturedRouteSample => ({
  capturedAt: new Date(Date.parse('2026-08-28T08:00:00.000Z') + index * 1_000).toISOString(),
  latitude: 56.85 + index * 0.00001,
  longitude: 53.2 + index * 0.00001,
  accuracyM: 12,
  speedMps: 4,
  headingDeg: 90,
})

describe('fenced route storage', () => {
  beforeEach(async () => {
    await offlineDb.delete()
    await offlineDb.open()
    await activateIdentity(context.identityId)
  })

  afterEach(async () => {
    await offlineDb.delete()
  })

  it('rejects a late callback after another tab acquires a higher writer generation', async () => {
    const now = Date.parse('2026-08-28T08:00:00.000Z')
    await getOrCreateRecorderSession(context, now)
    const tabA = await acquireWriterLease(context, 'tab-a', now)
    expect(tabA).not.toBeNull()
    expect(await persistRouteSample(context, tabA!, sample(1), now + 1_000)).toMatchObject({ sequence: 1 })
    expect(await acquireWriterLease(context, 'tab-b', now + 2_000)).toBeNull()

    const tabB = await acquireWriterLease(context, 'tab-b', now + WRITER_LEASE_TTL_MS + 1)
    expect(tabB?.writerGeneration).toBe((tabA?.writerGeneration ?? 0) + 1)
    expect(tabB?.fenceToken).not.toBe(tabA?.fenceToken)
    expect(await persistRouteSample(context, tabA!, sample(2), now + WRITER_LEASE_TTL_MS + 2)).toBeNull()
    expect(await persistRouteSample(context, tabB!, sample(2), now + WRITER_LEASE_TTL_MS + 2)).toMatchObject({ sequence: 2 })
  })

  it('keeps client and idempotency stable across reload retry, then rotates after receipt', async () => {
    const first = await getOrCreateRouteLeaseAttempt('user-a', 'kabanda-a', 'raid-a', 'acquire', 7)
    const retry = await getOrCreateRouteLeaseAttempt('user-a', 'kabanda-a', 'raid-a', 'acquire', 7)
    expect(retry).toEqual(first)
    await completeRouteLeaseAttempt('user-a', 'raid-a', first!.fingerprint)
    const nextVersion = await getOrCreateRouteLeaseAttempt('user-a', 'kabanda-a', 'raid-a', 'acquire', 8)
    expect(nextVersion?.clientInstanceId).toBe(first?.clientInstanceId)
    expect(nextVersion?.idempotencyKey).not.toBe(first?.idempotencyKey)
  })

  it('fails closed after an identity switch', async () => {
    const now = Date.parse('2026-08-28T08:00:00.000Z')
    await getOrCreateRecorderSession(context, now)
    const fence = await acquireWriterLease(context, 'tab-a', now)
    await activateIdentity('user-b')
    expect(await persistRouteSample(context, fence!, sample(1), now + 1_000)).toBeNull()
    expect(await claimRouteBatch(context, fence!, now + 1_000)).toBeNull()
  })

  it('claims no more than 50 isolated samples and retries the exact batch id', async () => {
    const now = Date.parse('2026-08-28T08:00:00.000Z')
    await getOrCreateRecorderSession(context, now)
    const fence = await acquireWriterLease(context, 'tab-a', now)
    for (let index = 1; index <= 55; index += 1) {
      await persistRouteSample(context, fence!, sample(index), now + 1_000)
    }
    const first = await claimRouteBatch(context, fence!, now + 1_100, 100)
    expect(first?.rows).toHaveLength(50)
    expect(new Set(first?.rows.map(({ identityId, raidId, navigatorLeaseId }) => `${identityId}:${raidId}:${navigatorLeaseId}`))).toEqual(new Set(['user-a:raid-a:lease-a']))
    await markRouteBatchRetryable(context, fence!, first!.batchId, 'NETWORK_ERROR', now + 1_200)
    const retry = await claimRouteBatch(context, fence!, now + 3_300)
    expect(retry?.batchId).toBe(first?.batchId)
    expect(retry?.rows.map(({ id }) => id)).toEqual(first?.rows.map(({ id }) => id))
  })

  it('settles only a complete exact receipt', async () => {
    const now = Date.parse('2026-08-28T08:00:00.000Z')
    await getOrCreateRecorderSession(context, now)
    const fence = await acquireWriterLease(context, 'tab-a', now)
    await persistRouteSample(context, fence!, sample(1), now + 1_000)
    await persistRouteSample(context, fence!, sample(2), now + 1_000)
    const batch = await claimRouteBatch(context, fence!, now + 1_100)
    const incomplete: RouteBatchResponse = {
      batchId: batch!.batchId,
      accepted: [{ operationId: batch!.rows[0]!.id, acceptedAt: '2026-08-28T08:00:02.000Z' }],
      duplicates: [],
      rejected: [],
      routeStatus: { status: 'fresh', lastSampleAt: '2026-08-28T08:00:02.000Z', lastReceivedAt: '2026-08-28T08:00:02.100Z', acceptedSampleCount: 1, missingSequenceCount: 0 },
      serverAt: '2026-08-28T08:00:02.000Z',
    }
    expect(await settleRouteBatch(context, fence!, batch!.batchId, incomplete, now + 1_200)).toBe(false)
    expect((await offlineDb.routeOutbox.where('batchId').equals(batch!.batchId).toArray()).every(({ status }) => status === 'sending')).toBe(true)

    const complete: RouteBatchResponse = {
      ...incomplete,
      accepted: [
        incomplete.accepted[0]!,
        { operationId: batch!.rows[1]!.id, acceptedAt: '2026-08-28T08:00:02.000Z' },
      ],
      routeStatus: { ...incomplete.routeStatus, acceptedSampleCount: 2 },
    }
    expect(await settleRouteBatch(context, fence!, batch!.batchId, complete, now + 1_300)).toBe(true)
    expect((await offlineDb.routeOutbox.where('batchId').equals(batch!.batchId).toArray()).every(({ status }) => status === 'accepted')).toBe(true)
  })
})
