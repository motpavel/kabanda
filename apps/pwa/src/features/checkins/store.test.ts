import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { offlineDb } from '../offline/db'
import { activateIdentity } from '../offline/ledger'
import {
  acquireCheckInSenderLease,
  claimNextCheckIn,
  claimNextMediaDraft,
  enqueueCheckIn,
  getCheckInLocalState,
  persistMediaDraft,
  reconcileAndCountUnsyncedCheckInWork,
  replaceExpiredMediaIntent,
  reserveFallbackSubmission,
  settleCheckIn,
  settleFallbackSubmission,
} from './store'

const evidence = {
  latitude: 56.85,
  longitude: 53.2,
  capturedAt: '2026-08-28T08:00:00.000Z',
  accuracyMeters: 12,
}

describe('identity-bound check-in outbox', () => {
  beforeEach(async () => {
    await offlineDb.delete()
    await offlineDb.open()
    await activateIdentity('user-a')
  })

  afterEach(async () => {
    await offlineDb.delete()
  })

  it('persists before pending UI and keeps the operation id through expired sending recovery', async () => {
    const now = Date.parse('2026-08-28T08:00:00.000Z')
    const queued = await enqueueCheckIn('user-a', 'kabanda-a', 'raid-a', {
      pointSnapshotId: 'point-a',
      evidence,
      presentParticipantIds: ['user-a', 'user-b'],
      organizerAttestation: false,
    }, now)
    expect(queued?.status).toBe('pending')
    const tabA = await acquireCheckInSenderLease('user-a', 'raid-a', 'tab-a', now)
    const sending = await claimNextCheckIn(tabA!, now + 1)
    expect(sending?.operationId).toBe(queued?.operationId)
    expect(await acquireCheckInSenderLease('user-a', 'raid-a', 'tab-b', now + 2)).toBeNull()

    const tabB = await acquireCheckInSenderLease('user-a', 'raid-a', 'tab-b', now + 30_001)
    const replay = await claimNextCheckIn(tabB!, now + 30_002)
    expect(replay?.operationId).toBe(queued?.operationId)
    expect(replay?.attempts).toBe(2)
  })

  it('stores needs_manual_verification as action required, not accepted', async () => {
    const now = Date.parse('2026-08-28T08:00:00.000Z')
    const queued = await enqueueCheckIn('user-a', 'kabanda-a', 'raid-a', {
      pointSnapshotId: 'point-a', evidence, presentParticipantIds: ['user-a'], organizerAttestation: false,
    }, now)
    const fence = await acquireCheckInSenderLease('user-a', 'raid-a', 'tab-a', now)
    await claimNextCheckIn(fence!, now + 1)
    expect(await settleCheckIn(fence!, queued!.operationId, {
      operationId: queued!.operationId,
      outcome: 'needs_manual_verification',
      reason: 'too_far',
      attemptId: 'attempt-a',
      point: { pointSnapshotId: 'point-a', sourcePointId: 'source-a', name: 'Точка' },
      credits: [],
      claims: [],
    }, now + 2)).toBe(true)
    const local = await getCheckInLocalState('user-a', 'raid-a')
    expect(local.unsynced).toBe(0)
    expect(local.needsAction[0]?.operationId).toBe(queued?.operationId)
  })

  it('refuses a receipt for another check-in operation', async () => {
    const now = Date.parse('2026-08-28T08:00:00.000Z')
    const queued = await enqueueCheckIn('user-a', 'kabanda-a', 'raid-a', {
      pointSnapshotId: 'point-a', evidence, presentParticipantIds: ['user-a'], organizerAttestation: false,
    }, now)
    const fence = await acquireCheckInSenderLease('user-a', 'raid-a', 'tab-a', now)
    await claimNextCheckIn(fence!, now + 1)
    expect(await settleCheckIn(fence!, queued!.operationId, {
      operationId: 'another-operation', outcome: 'accepted', reason: null, attemptId: 'attempt-a',
      point: { pointSnapshotId: 'point-a', sourcePointId: 'source-a', name: 'Точка' }, credits: [], claims: [],
    }, now + 2)).toBe(false)
  })

  it('quarantines another identity and persists only Blob/hash, never upload capability', async () => {
    const draft = await persistMediaDraft({
      identityId: 'user-a',
      kabandaId: 'kabanda-a',
      raidId: 'raid-a',
      blob: new Blob(['photo'], { type: 'image/jpeg' }),
      sourceSha256: 'abc',
      sizeBytes: 5,
      contentType: 'image/jpeg',
      caption: '',
      purpose: 'gallery',
      attemptId: null,
    })
    expect('uploadCapability' in draft!).toBe(false)
    await activateIdentity('user-b')
    expect(await getCheckInLocalState('user-a', 'raid-a')).toEqual({ unsynced: 0, needsAction: [], media: [] })
    const fence = await acquireCheckInSenderLease('user-b', 'raid-a', 'tab-b')
    expect(await claimNextMediaDraft(fence!)).toBeNull()
  })

  it('keeps client draft and bytes but rotates intent operation only after terminal expiry', async () => {
    const now = Date.parse('2026-08-28T08:00:00.000Z')
    const draft = await persistMediaDraft({
      identityId: 'user-a', kabandaId: 'kabanda-a', raidId: 'raid-a',
      blob: new Blob(['photo'], { type: 'image/jpeg' }), sourceSha256: 'abc', sizeBytes: 5,
      contentType: 'image/jpeg', caption: '', purpose: 'gallery', attemptId: null,
    }, now)
    const fence = await acquireCheckInSenderLease('user-a', 'raid-a', 'tab-a', now)
    await claimNextMediaDraft(fence!, now + 1)
    expect(await replaceExpiredMediaIntent(fence!, draft!.operationId, now + 2)).toBe(true)
    const rows = await offlineDb.mediaDrafts.where('clientDraftId').equals(draft!.clientDraftId).toArray()
    expect(rows).toHaveLength(2)
    expect(rows.find(({ operationId }) => operationId === draft?.operationId)?.status).toBe('rejected')
    expect(rows.find(({ operationId }) => operationId !== draft?.operationId)).toMatchObject({
      clientDraftId: draft!.clientDraftId, sourceSha256: 'abc', status: 'retryable',
    })
  })

  it('claims only an already-issued media intent during finalizing drain', async () => {
    const now = Date.parse('2026-08-28T08:00:00.000Z')
    const local = await persistMediaDraft({
      identityId: 'user-a', kabandaId: 'kabanda-a', raidId: 'raid-a',
      blob: new Blob(['local'], { type: 'image/jpeg' }), sourceSha256: 'local', sizeBytes: 5,
      contentType: 'image/jpeg', caption: null, purpose: 'gallery', attemptId: null,
    }, now)
    const issued = await persistMediaDraft({
      identityId: 'user-a', kabandaId: 'kabanda-a', raidId: 'raid-a',
      blob: new Blob(['issued'], { type: 'image/jpeg' }), sourceSha256: 'issued', sizeBytes: 6,
      contentType: 'image/jpeg', caption: null, purpose: 'gallery', attemptId: null,
    }, now + 1)
    await offlineDb.mediaDrafts.update(issued!.operationId, { intentId: 'intent-a' })
    const fence = await acquireCheckInSenderLease('user-a', 'raid-a', 'tab-a', now + 2)
    expect((await claimNextMediaDraft(fence!, now + 3, true))?.operationId).toBe(issued?.operationId)
    expect((await offlineDb.mediaDrafts.get(local!.operationId))?.status).toBe('local')
  })

  it('keeps only an issued media upload replayable in finalizing', async () => {
    const now = Date.parse('2026-08-28T08:00:00.000Z')
    const checkIn = await enqueueCheckIn('user-a', 'kabanda-a', 'raid-a', {
      pointSnapshotId: 'point-a', evidence, presentParticipantIds: ['user-a'], organizerAttestation: false,
    }, now)
    const local = await persistMediaDraft({
      identityId: 'user-a', kabandaId: 'kabanda-a', raidId: 'raid-a',
      blob: new Blob(['local'], { type: 'image/jpeg' }), sourceSha256: 'local', sizeBytes: 5,
      contentType: 'image/jpeg', caption: null, purpose: 'gallery', attemptId: null,
    }, now)
    const issued = await persistMediaDraft({
      identityId: 'user-a', kabandaId: 'kabanda-a', raidId: 'raid-a',
      blob: new Blob(['issued'], { type: 'image/jpeg' }), sourceSha256: 'issued', sizeBytes: 6,
      contentType: 'image/jpeg', caption: null, purpose: 'gallery', attemptId: null,
    }, now + 1)
    await offlineDb.mediaDrafts.update(issued!.operationId, { intentId: 'intent-a' })
    await offlineDb.raidProjections.put({
      key: JSON.stringify(['user-a', 'raid-a']), identityId: 'user-a', raidId: 'raid-a',
      kabandaId: 'kabanda-a', state: 'finalizing', savedAt: new Date(now + 2).toISOString(), projection: {},
    })

    expect(await reconcileAndCountUnsyncedCheckInWork(now + 3)).toBe(1)
    expect(await offlineDb.checkInOutbox.get(checkIn!.operationId)).toMatchObject({ status: 'rejected' })
    expect(await offlineDb.mediaDrafts.get(local!.operationId)).toMatchObject({ status: 'rejected' })
    expect(await offlineDb.mediaDrafts.get(issued!.operationId)).toMatchObject({
      status: 'local', intentId: 'intent-a', sourceSha256: 'issued',
    })
  })

  it('terminalizes replay work after the canonical raid leaves active without deleting evidence', async () => {
    const now = Date.parse('2026-08-28T08:00:00.000Z')
    const checkIn = await enqueueCheckIn('user-a', 'kabanda-a', 'raid-a', {
      pointSnapshotId: 'point-a', evidence, presentParticipantIds: ['user-a'], organizerAttestation: false,
    }, now)
    const media = await persistMediaDraft({
      identityId: 'user-a', kabandaId: 'kabanda-a', raidId: 'raid-a',
      blob: new Blob(['evidence'], { type: 'image/jpeg' }), sourceSha256: 'abc', sizeBytes: 8,
      contentType: 'image/jpeg', caption: null, purpose: 'fallback', attemptId: 'attempt-a',
    }, now)
    await offlineDb.raidProjections.put({
      key: JSON.stringify(['user-a', 'raid-a']), identityId: 'user-a', raidId: 'raid-a',
      kabandaId: 'kabanda-a', state: 'paused', savedAt: new Date(now + 1).toISOString(), projection: {},
    })

    expect(await reconcileAndCountUnsyncedCheckInWork(now + 2)).toBe(0)
    expect(await offlineDb.checkInOutbox.get(checkIn!.operationId)).toMatchObject({
      status: 'rejected', pointSnapshotId: 'point-a', evidence,
      lastErrorCode: 'RAID_NOT_ACTIVE_LOCAL_RECONCILIATION',
    })
    const retainedMedia = await offlineDb.mediaDrafts.get(media!.operationId)
    expect(retainedMedia).toMatchObject({ status: 'rejected', sourceSha256: 'abc' })
    expect(await retainedMedia!.blob.text()).toBe('evidence')
  })

  it('reserves one durable fallback request per failed attempt and settles the same reservation', async () => {
    const now = Date.parse('2026-08-28T08:00:00.000Z')
    const queued = await enqueueCheckIn('user-a', 'kabanda-a', 'raid-a', {
      pointSnapshotId: 'point-a', evidence, presentParticipantIds: ['user-a'], organizerAttestation: false,
    }, now)
    const fence = await acquireCheckInSenderLease('user-a', 'raid-a', 'tab-a', now)
    await claimNextCheckIn(fence!, now + 1)
    await settleCheckIn(fence!, queued!.operationId, {
      operationId: queued!.operationId, outcome: 'needs_manual_verification', reason: 'too_far',
      attemptId: 'attempt-a', point: { pointSnapshotId: 'point-a', sourcePointId: 'source-a', name: 'Точка' },
      credits: [], claims: [],
    }, now + 2)
    const first = await reserveFallbackSubmission('user-a', 'raid-a', 'attempt-a', {
      attemptId: 'attempt-a', mediaId: 'media-a', verifierUserId: 'user-b',
      presentParticipantIds: ['user-a'], reason: 'Первый payload',
    }, now + 3)
    const retryAfterReload = await reserveFallbackSubmission('user-a', 'raid-a', 'attempt-a', {
      attemptId: 'attempt-a', mediaId: 'media-b', verifierUserId: 'user-c',
      presentParticipantIds: ['user-a'], reason: 'Изменённый payload',
    }, now + 4)
    expect(retryAfterReload).toEqual(first)
    expect(await settleFallbackSubmission('user-a', 'raid-a', 'attempt-a', first!.operationId, {
      fallback: {
        id: 'fallback-a', attemptId: 'attempt-a', mediaId: 'media-a', verifierUserId: 'user-b',
        status: 'pending_verifier', reason: 'Первый payload', expiresAt: '2026-08-28T08:10:00.000Z',
      },
    }, now + 5)).toBe(true)
    expect((await getCheckInLocalState('user-a', 'raid-a')).needsAction[0]?.fallbackSubmission).toMatchObject({
      operationId: first!.operationId, status: 'submitted', fallbackId: 'fallback-a',
    })
  })
})
