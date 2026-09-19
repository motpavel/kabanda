import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { offlineDb } from '../offline/db'
import { activateIdentity } from '../offline/ledger'
import type { MediaDraftRecord } from '../offline/types'
import { FieldSyncScheduler, nextFieldWake } from '../raids/field-scheduler'
import { readLegacyRetryWork } from './use-legacy-retry'
import { enqueueCheckIn } from './store'

const identityId = 'legacy-owner', raidId = 'legacy-raid'
const at = Date.parse('2026-09-19T12:00:00Z')
const bytes = new Uint8Array([255, 216, 255, 1, 0, 255, 217])
const draft = (status: MediaDraftRecord['status'] = 'retryable'): MediaDraftRecord => ({
  operationId: 'legacy-photo', clientDraftId: 'same-draft', identityId, raidId, kabandaId: 'team',
  blob: new Blob([bytes], { type: 'image/jpeg' }), sourceSha256: 'a'.repeat(64), sizeBytes: bytes.length,
  contentType: 'image/jpeg', caption: null, purpose: 'gallery', attemptId: null,
  status, intentId: null, mediaId: null, attempts: 1, claimUntil: null,
  nextAttemptAt: new Date(at + 2000).toISOString(), createdAt: new Date(at).toISOString(),
  updatedAt: new Date(at).toISOString(), lastErrorCode: 'NETWORK_ERROR',
})
beforeEach(async () => {
  await offlineDb.delete(); await offlineDb.open(); await activateIdentity(identityId)
})
afterEach(() => vi.useRealTimers())

describe('legacy scheduling without changing stored evidence', () => {
  it('uses the real next-attempt deadline and excludes settled photographs', async () => {
    const row = draft(); await offlineDb.mediaDrafts.put(row)
    await offlineDb.mediaDrafts.put({ ...draft('accepted'), operationId: 'accepted-photo' })
    await offlineDb.mediaDrafts.put({ ...draft('rejected'), operationId: 'rejected-photo' })
    const work = await readLegacyRetryWork(identityId, raidId)
    expect(work).toHaveLength(1)
    expect(nextFieldWake(work, at)).toBe(2000)
    expect(work[0]).not.toHaveProperty('blob')
    expect(work[0]).not.toHaveProperty('sourceSha256')
    expect(await offlineDb.mediaDrafts.get(row.operationId)).toEqual(row)
    expect(new Uint8Array(await (await offlineDb.mediaDrafts.get(row.operationId))!.blob.arrayBuffer())).toEqual(bytes)
  })
  it('waits for an existing upload claim instead of racing its sender', async () => {
    await offlineDb.mediaDrafts.put({ ...draft('uploading'), claimUntil: new Date(at + 180_000).toISOString() })
    expect(nextFieldWake(await readLegacyRetryWork(identityId, raidId), at)).toBe(180_000)
  })
  it('ignores another user or raid and stops after identity change', async () => {
    await offlineDb.mediaDrafts.put(draft())
    await offlineDb.mediaDrafts.put({ ...draft(), operationId: 'another-raid', raidId: 'another-raid' })
    await offlineDb.mediaDrafts.put({ ...draft(), operationId: 'another-user', identityId: 'another-user' })
    expect(await readLegacyRetryWork(identityId, raidId)).toHaveLength(1)
    await activateIdentity('another-user')
    expect(await readLegacyRetryWork(identityId, raidId)).toEqual([])
    expect(await offlineDb.mediaDrafts.count()).toBe(3)
  })
  it('includes pending old check-ins without changing their operation or evidence', async () => {
    const record = await enqueueCheckIn(identityId, 'team', raidId, {
      pointSnapshotId: 'point', evidence: { latitude: 56.86, longitude: 53.21, accuracyMeters: 8, capturedAt: new Date(at).toISOString() },
      presentParticipantIds: [identityId], organizerAttestation: false,
    })
    expect(record).not.toBeNull()
    const rows = await readLegacyRetryWork(identityId, raidId)
    expect(rows.map(row => row.operationId)).toEqual([record!.operationId])
    expect(await offlineDb.checkInOutbox.get(record!.operationId)).toEqual(record)
  })
  it('automatically wakes once at the stored retry time without another event or manual click', async () => {
    await offlineDb.mediaDrafts.put(draft())
    let work = await readLegacyRetryWork(identityId, raidId)
    vi.useFakeTimers(); vi.setSystemTime(at)
    const pump = vi.fn(async () => { work = [] })
    const scheduler = new FieldSyncScheduler({ read: async () => work, pump, available: () => true })
    try {
      scheduler.wake()
      await vi.advanceTimersByTimeAsync(1999)
      expect(pump).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(pump).toHaveBeenCalledExactlyOnceWith(raidId, 'team')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(pump).toHaveBeenCalledTimes(1)
    } finally { scheduler.stop() }
  })
  it('does not send while unavailable or after the retry owner is stopped', async () => {
    await offlineDb.mediaDrafts.put(draft())
    const work = await readLegacyRetryWork(identityId, raidId)
    vi.useFakeTimers(); vi.setSystemTime(at)
    let available = false
    const pump = vi.fn(async () => {})
    const scheduler = new FieldSyncScheduler({ read: async () => work, pump, available: () => available })
    scheduler.wake(); await vi.advanceTimersByTimeAsync(10_000)
    expect(pump).not.toHaveBeenCalled()
    available = true; scheduler.wake(); scheduler.stop()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pump).not.toHaveBeenCalled()
  })
})
