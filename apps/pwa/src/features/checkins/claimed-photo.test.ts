import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { offlineDb } from '../offline/db'
import { activateIdentity } from '../offline/ledger'
import type { MediaDraftRecord } from '../offline/types'
import { materializeClaimedPhoto } from './claimed-photo'

const identityId = 'photo-owner', raidId = 'photo-raid'
const source = new Uint8Array([255, 216, 255, 128, 0, 17, 255, 217])
const now = new Date().toISOString()
const draft = (): MediaDraftRecord => ({ operationId: 'photo-operation', clientDraftId: 'photo-draft', identityId,
  raidId, kabandaId: 'photo-team', blob: new Blob([source], { type: 'image/jpeg' }), sourceSha256: 'a'.repeat(64),
  sizeBytes: source.length, contentType: 'image/jpeg', caption: 'Synthetic', purpose: 'gallery', attemptId: null,
  status: 'uploading', intentId: null, mediaId: null, attempts: 1, claimUntil: now,
  nextAttemptAt: null, createdAt: now, updatedAt: now, lastErrorCode: null })
beforeEach(async () => {
  await offlineDb.delete(); await offlineDb.open(); await activateIdentity(identityId)
})

describe('materializing a current claimed photograph', () => {
  it('reads the current stored Blob, not a stale object returned before a metadata write', async () => {
    const expected = draft()
    await offlineDb.mediaDrafts.put(expected)
    vi.spyOn(expected.blob, 'arrayBuffer').mockRejectedValue(new TypeError('Obsolete backing'))
    const upload = await materializeClaimedPhoto(expected)
    expect(new Uint8Array(await upload.arrayBuffer())).toEqual(source)
    expect(expected.blob.arrayBuffer).not.toHaveBeenCalled()
    await offlineDb.mediaDrafts.update(expected.operationId, { intentId: 'issued-intent' })
    expect(new Uint8Array(await upload.arrayBuffer())).toEqual(source)
    expect(upload.type).toBe(expected.contentType)
  })
  it('does not rewrite or delete the operation while preparing upload bytes', async () => {
    const expected = draft(); await offlineDb.mediaDrafts.put(expected)
    const before = await offlineDb.mediaDrafts.get(expected.operationId)
    await materializeClaimedPhoto(expected)
    expect(await offlineDb.mediaDrafts.get(expected.operationId)).toEqual(before)
  })
  it('refuses foreign identity and keeps the original photo', async () => {
    const expected = draft(); await offlineDb.mediaDrafts.put(expected)
    await activateIdentity('another-user')
    await expect(materializeClaimedPhoto(expected)).rejects.toThrow('identity changed')
    expect(await offlineDb.mediaDrafts.count()).toBe(1)
  })
  it('refuses replaced claims, metadata, or a completed operation', async () => {
    for (const change of [{ attempts: 2 }, { status: 'accepted' as const }, { sourceSha256: 'b'.repeat(64) },
      { raidId: 'another-raid' }, { sizeBytes: 7 }, { clientDraftId: 'another-draft' }]) {
      const expected = draft(); await offlineDb.mediaDrafts.put({ ...expected, ...change })
      await expect(materializeClaimedPhoto(expected)).rejects.toThrow('claim changed')
    }
  })
})
