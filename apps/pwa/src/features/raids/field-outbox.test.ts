import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestJson } from '../../lib/http'
import { offlineDb } from '../offline/db'
import { activateIdentity } from '../offline/ledger'
import { enqueueCheckIn } from '../checkins/store'
import { enqueueField, fieldDb, fieldInventory, fieldOperations, pumpFieldOperations, type FieldOperation } from './field-outbox'
import { nextFieldWake } from './use-field-queue'

vi.mock('../../lib/http', async importOriginal => {
  const original = await importOriginal<typeof import('../../lib/http')>()
  return { ...original, requestJson: vi.fn() }
})
const send = vi.mocked(requestJson)
const owner = 'user-a', team = 'team-a', raid = 'raid-a', point = 'point-a'
const evidence = { latitude: 56.86, longitude: 53.21, accuracyMeters: 8, capturedAt: '2026-09-19T12:00:00Z' }
const context = { identityId: owner, kabandaId: team, raidId: raid, pointId: point }
const teamInput = { ...context, kind: 'team' as const, payload: {
  pointSnapshotId: point, evidence, presentParticipantIds: [owner, 'user-b'], confirmedAttendance: true as const,
} }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function accepted(operationId: string) {
  return { operationId, attemptId: 'server-attempt', outcome: 'accepted', reason: null,
    point: { pointSnapshotId: point, sourcePointId: 'source-a', name: 'Остановка' },
    credits: [], claims: [] }
}

describe('independent durable field lanes', () => {
  let now = Date.parse('2026-09-19T12:00:00Z')
  beforeEach(async () => {
    send.mockReset()
    now = Date.parse('2026-09-19T12:00:00Z')
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await fieldDb.delete(); await fieldDb.open()
    await offlineDb.delete(); await offlineDb.open()
    await activateIdentity(owner)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fieldDb.delete()
    await offlineDb.delete()
  })

  it('sends and acknowledges a team visit while a photo PUT is still waiting', async () => {
    const upload = deferred<unknown>()
    let photoStarted = false
    const blob = new Blob(['saved-photo-bytes'], { type: 'image/jpeg' })
    const photo = await enqueueField({ ...context, kind: 'photo', blob, payload: {
      kind: 'photo', body: 'Остановка', sourceSha256: 'a'.repeat(64), contentType: 'image/jpeg', sizeBytes: blob.size,
    } })
    send.mockImplementation(async (path, init) => {
      if (path.endsWith('/materials')) return { material: { id: 'server-photo', ready: false } }
      if (path.endsWith('/content')) { photoStarted = true; return upload.promise }
      return accepted(String((init!.headers as Record<string, string>)['Idempotency-Key']))
    })
    const materialRun = pumpFieldOperations(owner, raid, 'materials')
    try {
      await vi.waitFor(() => expect(photoStarted).toBe(true))
      const visit = await enqueueField(teamInput)
      await pumpFieldOperations(owner, raid, 'team')
      expect((await fieldDb.operations.get(visit.operationId))?.status).toBe('accepted')
      expect((await fieldDb.operations.get(photo.operationId))?.status).toBe('sending')
      expect(await (await fieldDb.operations.get(photo.operationId))!.blob!.text()).toBe('saved-photo-bytes')
    } finally {
      upload.resolve({ material: { id: 'server-photo', ready: true } })
      await materialRun
    }
    expect((await fieldDb.operations.get(photo.operationId))?.status).toBe('accepted')
  })

  it('keeps the exact operation ID, evidence and attendance through delayed retry', async () => {
    const row = await enqueueField(teamInput)
    send.mockRejectedValueOnce(new ApiError(503, 'TEMPORARY', 'Temporary outage'))
    await pumpFieldOperations(owner, raid, 'team')
    const retry = await fieldDb.operations.get(row.operationId)
    expect(retry).toMatchObject({ status: 'retryable', attempts: 1, nextAttemptAt: now + 2000 })
    const firstBody = send.mock.calls[0]![1]!.body
    now += 1999
    await pumpFieldOperations(owner, raid, 'team')
    expect(send).toHaveBeenCalledTimes(1)
    now += 1
    send.mockResolvedValueOnce(accepted(row.operationId))
    await pumpFieldOperations(owner, raid, 'team')
    expect(send.mock.calls[1]![1]!.body).toBe(firstBody)
    expect(send.mock.calls[1]![1]!.headers).toEqual({ 'Idempotency-Key': row.operationId })
    expect((await fieldDb.operations.get(row.operationId))?.payload).toEqual(row.payload)
    expect((await fieldDb.operations.get(row.operationId))?.attempts).toBe(2)
  })

  it('shares an active lane without inventing a second command or changing a pending selection', async () => {
    const gate = deferred<unknown>(), row = await enqueueField(teamInput)
    send.mockImplementation(() => gate.promise)
    const first = pumpFieldOperations(owner, raid, 'team')
    const second = pumpFieldOperations(owner, raid, 'team')
    expect(first).toBe(second)
    try {
      expect((await enqueueField(teamInput)).operationId).toBe(row.operationId)
      await expect(enqueueField({ ...teamInput, payload: { ...teamInput.payload, presentParticipantIds: [owner] } })).rejects.toThrow()
    } finally { gate.resolve(accepted(row.operationId)); await first }
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not accept a delayed response into another signed-in identity', async () => {
    const gate = deferred<unknown>(), row = await enqueueField(teamInput)
    send.mockImplementation(() => gate.promise)
    const run = pumpFieldOperations(owner, raid, 'team')
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      await activateIdentity('user-b')
    } finally { gate.resolve(accepted(row.operationId)); await run }
    expect(await fieldOperations(owner, raid)).toEqual([])
    expect(await fieldOperations('user-b', raid)).toEqual([])
    expect((await fieldDb.operations.get(row.operationId))?.status).toBe('sending')
    await activateIdentity(owner)
    now += 180_001
    send.mockResolvedValueOnce(accepted(row.operationId))
    await pumpFieldOperations(owner, raid, 'team')
    expect((await fieldDb.operations.get(row.operationId))?.status).toBe('accepted')
  })

  it('leaves existing GPS, check-in and photo data untouched while sending a new visit', async () => {
    await enqueueCheckIn(owner, team, raid, { pointSnapshotId: 'legacy-point', evidence,
      presentParticipantIds: [owner], organizerAttestation: false })
    const photoBlob = new Blob(['legacy-photo'], { type: 'image/jpeg' })
    await offlineDb.mediaDrafts.add({ operationId: 'legacy-media-op', clientDraftId: 'legacy-media', identityId: owner,
      kabandaId: team, raidId: raid, blob: photoBlob, sourceSha256: 'b'.repeat(64), sizeBytes: photoBlob.size,
      contentType: 'image/jpeg', caption: 'Старое фото', purpose: 'gallery', attemptId: null,
      status: 'retryable', intentId: 'old-intent', mediaId: null, attempts: 3, claimUntil: null,
      nextAttemptAt: new Date(now + 5000).toISOString(), createdAt: evidence.capturedAt,
      updatedAt: evidence.capturedAt, lastErrorCode: 'OFFLINE' })
    await offlineDb.routeOutbox.add({ operationId: 'legacy-gps', identityId: owner, kabandaId: team, raidId: raid,
      navigatorLeaseId: 'lease-a', leaseGeneration: 1, clientInstanceId: 'client-a', sequence: 7,
      capturedAt: evidence.capturedAt, latitude: evidence.latitude, longitude: evidence.longitude, accuracyM: 8,
      speedMps: null, headingDeg: null, status: 'retryable', batchId: 'old-batch', attempts: 2,
      nextAttemptAt: new Date(now + 5000).toISOString(), claimUntil: null })
    const before = { gps: await offlineDb.routeOutbox.toArray(), checkins: await offlineDb.checkInOutbox.toArray(), media: await offlineDb.mediaDrafts.toArray() }
    const visit = await enqueueField(teamInput)
    send.mockResolvedValueOnce(accepted(visit.operationId))
    await pumpFieldOperations(owner, raid, 'team')
    expect(await offlineDb.routeOutbox.toArray()).toEqual(before.gps)
    expect(await offlineDb.checkInOutbox.toArray()).toEqual(before.checkins)
    expect(await offlineDb.mediaDrafts.toArray()).toEqual(before.media)
    expect(await (await offlineDb.mediaDrafts.get('legacy-media'))!.blob.text()).toBe('legacy-photo')
  })

  it('bridges only a server-created manual attempt, never a pending v2 command', async () => {
    const visit = await enqueueField(teamInput)
    expect(await offlineDb.checkInOutbox.count()).toBe(0)
    send.mockResolvedValueOnce({ ...accepted(visit.operationId), outcome: 'needs_manual_verification', reason: 'accuracy_insufficient' })
    await pumpFieldOperations(owner, raid, 'team')
    expect(await offlineDb.checkInOutbox.get(visit.operationId)).toMatchObject({
      status: 'needs_action', evidence, organizerAttestation: false, operationId: visit.operationId,
      response: { outcome: 'needs_manual_verification', attemptId: 'server-attempt' },
    })
    expect((await fieldDb.operations.get(visit.operationId))?.response).toMatchObject({ outcome: 'needs_manual_verification' })
  })

  it('accounts for new work before finish and uses claim and retry deadlines for wakeups', async () => {
    const visit = await enqueueField(teamInput)
    await enqueueField({ ...context, kind: 'comment', payload: { kind: 'comment', body: 'Сохранено офлайн' } })
    expect(await fieldInventory(owner, raid)).toEqual({ teamPending: 1, materialPending: 1, teamRejected: 0 })
    expect(nextFieldWake([], now)).toBeNull()
    expect(nextFieldWake([visit], now)).toBe(250)
    const claimed: FieldOperation = { ...visit, status: 'sending', claimUntil: now + 180_000, nextAttemptAt: now + 2000 }
    expect(nextFieldWake([claimed], now)).toBe(180_000)
  })
})
