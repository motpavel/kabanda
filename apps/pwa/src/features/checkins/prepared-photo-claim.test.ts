import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { offlineDb } from '../offline/db'
import { activateIdentity } from '../offline/ledger'
import { acquireCheckInSenderLease, claimNextMediaDraft, persistMediaDraft, rememberMediaIntent, retryMediaDraft } from './store'
import { materializeClaimedPhoto } from './claimed-photo'
import { claimPreparedPhoto } from './prepared-photo-claim'

vi.mock('./claimed-photo', async original => {
  const actual = await original<typeof import('./claimed-photo')>()
  return { ...actual, materializeClaimedPhoto: vi.fn(actual.materializeClaimedPhoto) }
})
const identityId = 'prepared-owner', raidId = 'prepared-raid', now = Date.parse('2026-09-19T12:00:00Z')
const bytes = new Uint8Array([255, 216, 255, 0, 128, 17, 255, 217])
let actual: typeof materializeClaimedPhoto
beforeEach(async () => {
  vi.restoreAllMocks()
  actual = (await vi.importActual<typeof import('./claimed-photo')>('./claimed-photo')).materializeClaimedPhoto
  vi.mocked(materializeClaimedPhoto).mockReset().mockImplementation(actual)
  vi.spyOn(Date, 'now').mockReturnValue(now)
  await offlineDb.delete(); await offlineDb.open(); await activateIdentity(identityId)
})
afterEach(() => vi.restoreAllMocks())
async function setup() {
  const row = (await persistMediaDraft({ identityId, kabandaId: 'prepared-team', raidId,
    blob: new Blob([bytes], { type: 'image/jpeg' }), sourceSha256: 'a'.repeat(64), sizeBytes: bytes.length,
    contentType: 'image/jpeg', caption: 'Original', purpose: 'gallery', attemptId: null }, now))!
  const fence = (await acquireCheckInSenderLease(identityId, raidId, 'prepared-tab', now))!
  return { row, fence }
}

describe('copy original bytes before the metadata-writing photo claim', () => {
  it('materializes outside a write transaction while the row is still local', async () => {
    const { row, fence } = await setup()
    vi.mocked(materializeClaimedPhoto).mockImplementation(async candidate => {
      expect((await offlineDb.mediaDrafts.get(candidate.operationId))!.status).toBe('local')
      return actual(candidate)
    })
    const prepared = (await claimPreparedPhoto(fence))!
    expect(prepared.error).toBeNull()
    expect(prepared.media).toMatchObject({ operationId: row.operationId, status: 'uploading', attempts: 1 })
    await rememberMediaIntent(fence, row.operationId, 'issued-intent', now)
    expect(new Uint8Array(await prepared.uploadBlob!.arrayBuffer())).toEqual(bytes)
    expect(prepared.uploadBlob!.type).toBe(row.contentType)
  })
  it('keeps a failed read as the same claimed operation for its durable retry', async () => {
    const { row, fence } = await setup()
    vi.mocked(materializeClaimedPhoto).mockRejectedValueOnce(new DOMException('Temporary backing file', 'NotFoundError'))
    const failed = (await claimPreparedPhoto(fence))!
    expect(failed.uploadBlob).toBeNull()
    expect(failed.error).toMatchObject({ name: 'NotFoundError' })
    expect(failed.media.attempts).toBe(1)
    expect(await retryMediaDraft(fence, row.operationId, 'NETWORK_ERROR', false, now)).toBe(true)
    expect(await claimPreparedPhoto(fence)).toBeNull()
    vi.mocked(Date.now).mockReturnValue(now + 2001)
    const recovered = (await claimPreparedPhoto(fence))!
    expect(recovered.media).toMatchObject({ operationId: row.operationId, clientDraftId: row.clientDraftId,
      sourceSha256: row.sourceSha256, attempts: 2, status: 'uploading' })
    expect(new Uint8Array(await recovered.uploadBlob!.arrayBuffer())).toEqual(bytes)
    expect(await offlineDb.mediaDrafts.count()).toBe(1)
  })
  it('does not acquire a claim after identity changes during a local read', async () => {
    const { row, fence } = await setup()
    vi.mocked(materializeClaimedPhoto).mockImplementation(async () => {
      await activateIdentity('different-user'); return new Blob([bytes])
    })
    expect(await claimPreparedPhoto(fence)).toBeNull()
    expect(await offlineDb.mediaDrafts.get(row.operationId)).toMatchObject({ status: 'local', attempts: 0 })
  })
  it('does not race another completed claim during file preparation', async () => {
    const { row, fence } = await setup()
    vi.mocked(materializeClaimedPhoto).mockImplementation(async () => {
      await claimNextMediaDraft(fence, now); return new Blob([bytes])
    })
    expect(await claimPreparedPhoto(fence)).toBeNull()
    expect(await offlineDb.mediaDrafts.get(row.operationId)).toMatchObject({ status: 'uploading', attempts: 1 })
  })
  it('does not claim with an expired sender fence even when bytes were readable', async () => {
    const { row, fence } = await setup()
    vi.mocked(Date.now).mockReturnValue(now + 180_001)
    expect(await claimPreparedPhoto(fence)).toBeNull()
    expect(await offlineDb.mediaDrafts.get(row.operationId)).toMatchObject({ status: 'local', attempts: 0 })
  })
  it('retains the issued-only restriction used during finalization', async () => {
    const { row, fence } = await setup()
    expect(await claimPreparedPhoto(fence, true)).toBeNull()
    expect(materializeClaimedPhoto).not.toHaveBeenCalled()
    await offlineDb.mediaDrafts.update(row.operationId, { intentId: 'previous-intent' })
    expect((await claimPreparedPhoto(fence, true))!.media.intentId).toBe('previous-intent')
  })
  it('never attaches prepared bytes to changed immutable metadata', async () => {
    const { row, fence } = await setup()
    vi.mocked(materializeClaimedPhoto).mockImplementation(async () => {
      await offlineDb.mediaDrafts.update(row.operationId, { caption: 'Changed elsewhere' })
      return new Blob([bytes])
    })
    const prepared = (await claimPreparedPhoto(fence))!
    expect(prepared.uploadBlob).toBeNull()
    expect(prepared.error).toBeInstanceOf(TypeError)
    expect(prepared.media.caption).toBe('Changed elsewhere')
  })
})
