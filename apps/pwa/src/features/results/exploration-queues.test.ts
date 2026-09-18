import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestJson } from '../../lib/http'
import { offlineDb } from '../offline/db'
import { activateIdentity, enqueueOperation } from '../offline/ledger'
import { raidReadDb } from '../raids/cache'
import { resetRaidResources } from '../raids/resources'
import { pagedHistoryResource, pointProgressResource } from './exploration-resources'

vi.mock('../../lib/http', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/http')>(), requestJson: vi.fn() }))
const identity = '11111111-1111-4111-8111-111111111111'
const team = '22222222-2222-4222-8222-222222222222'
const raid = '44444444-4444-4444-8444-000000000001'
const at = '2026-09-18T12:00:00Z'
const metrics = { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0 }
const historyPage = { schemaVersion: 2, scope: 'all', raids: [{ raidId: raid, title: 'История', completedAt: at,
  partial: false, participated: true, team: metrics, personal: metrics }], nextCursor: null }
const progressPage = { category: 'stores', collectionId: null, complete: true,
  points: [{ pointId: null, stableId: 'store', personalCount: 0, teamCount: 1 }] }

async function seedQueues() {
  await enqueueOperation('check-in.submit', raid, { synthetic: true, point: 'snapshot' })
  await offlineDb.routeOutbox.put({ id: 'gps-sample', identityId: identity, kabandaId: team, raidId: raid,
    navigatorLeaseId: 'navigator', leaseGeneration: 3, clientInstanceId: 'device', sequence: 7,
    capturedAt: at, latitude: 56.86, longitude: 53.21, accuracyM: 8, speedMps: 2, headingDeg: 90,
    status: 'retryable', batchId: 'stable-batch', attempts: 2, nextAttemptAt: at, claimUntil: null,
    lastErrorCode: 'NETWORK_ERROR' })
  await offlineDb.recorderSessions.put({ key: 'recorder', identityId: identity, kabandaId: team, raidId: raid,
    navigatorLeaseId: 'navigator', leaseGeneration: 3, clientInstanceId: 'device', wanted: true,
    nextSequence: 8, lastPersistedSampleAt: at, lastLatitude: 56.86, lastLongitude: 53.21,
    preliminaryDistanceM: 123, updatedAt: at })
  await offlineDb.checkInOutbox.put({ operationId: 'checkin', identityId: identity, kabandaId: team, raidId: raid,
    pointSnapshotId: 'snapshot', repeatVisit: true, evidence: { latitude: 56.86, longitude: 53.21, capturedAt: at, accuracyMeters: 8 },
    presentParticipantIds: [identity], organizerAttestation: false, status: 'retryable', attempts: 3,
    claimUntil: null, nextAttemptAt: at, createdAt: at, updatedAt: at, lastErrorCode: 'NETWORK_ERROR', response: null,
    fallbackSubmission: { operationId: 'fallback-command', input: { attemptId: 'attempt', mediaId: 'media',
      verifierUserId: identity, presentParticipantIds: [identity], reason: 'Synthetic test' },
      status: 'pending', fallbackId: null, updatedAt: at } })
  const blob = new Blob([new Uint8Array([255, 216, 255, 1, 2, 3, 255, 217])], { type: 'image/jpeg' })
  await offlineDb.mediaDrafts.put({ operationId: 'photo', clientDraftId: 'local-photo', identityId: identity,
    kabandaId: team, raidId: raid, blob, sourceSha256: 'a'.repeat(64), sizeBytes: blob.size,
    contentType: 'image/jpeg', caption: 'Несинхронизированное фото', purpose: 'fallback', attemptId: 'attempt',
    status: 'retryable', intentId: 'existing-intent', mediaId: null, attempts: 4, claimUntil: null,
    nextAttemptAt: at, createdAt: at, updatedAt: at, lastErrorCode: 'NETWORK_ERROR' })
}

async function queuedData() {
  const [outbox, gps, sessions, checkins, media] = await Promise.all([
    offlineDb.outbox.toArray(), offlineDb.routeOutbox.toArray(), offlineDb.recorderSessions.toArray(),
    offlineDb.checkInOutbox.toArray(), offlineDb.mediaDrafts.toArray(),
  ])
  // Compare the actual photo bytes as well as intent IDs, retry counters and
  // immutable operation identities. Merely asserting table sizes is not enough.
  const photos = await Promise.all(media.map(async ({ blob, ...record }) => ({ ...record,
    blobType: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] })))
  return { outbox, gps, sessions, checkins, photos }
}

beforeEach(async () => {
  resetRaidResources(); vi.clearAllMocks()
  await offlineDb.delete(); await offlineDb.open()
  await raidReadDb.delete(); await raidReadDb.open()
  await activateIdentity(identity)
  await seedQueues()
  vi.mocked(requestJson).mockImplementation(async path => String(path).includes('/points/progress') ? progressPage : historyPage)
})
afterEach(() => resetRaidResources())

describe('exploration reads never mutate operational queues', () => {
  it.each(['history', 'point-progress'] as const)('%s permission denial only removes private read models', async kind => {
    const history = pagedHistoryResource(identity, team, 'all')
    const progress = pointProgressResource(identity, team, 'stores')
    await history.refresh(); await progress.refresh()
    await history.settled(); await progress.settled()
    expect(await raidReadDb.snapshots.count()).toBe(2)
    const before = await queuedData()
    vi.mocked(requestJson).mockRejectedValue(new ApiError('FORBIDDEN', 'Access revoked', 403))
    await (kind === 'history' ? history : progress).refresh()
    await history.settled(); await progress.settled()
    expect(history.state).toMatchObject({ status: 'access-error', data: null })
    expect(progress.state).toMatchObject({ status: 'access-error', data: null })
    expect(await raidReadDb.snapshots.count()).toBe(0)
    expect(await queuedData()).toEqual(before)
  })

  it('a late response after identity switch cannot overwrite reads or reassign queued evidence', async () => {
    let resolve!: (value: unknown) => void
    const delayed = new Promise<unknown>(done => { resolve = done })
    vi.mocked(requestJson).mockReturnValue(delayed)
    const history = pagedHistoryResource(identity, team, 'all')
    const before = await queuedData()
    const pending = history.refresh()
    resetRaidResources('other-identity')
    await activateIdentity('other-identity')
    resolve(historyPage)
    await pending; await history.settled()
    expect(history.state.data).toBeNull()
    expect(await raidReadDb.snapshots.count()).toBe(0)
    expect(await queuedData()).toEqual(before)
  })
})
