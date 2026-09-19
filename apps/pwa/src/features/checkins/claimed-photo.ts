import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import type { MediaDraftRecord } from '../offline/types'
import { readPhotoUploadBody } from './upload-body'

/** Read one COMMITTED row, not an optimistic clone held by reactive queries.
 * The failing browser traces repeatedly read an unavailable cached Blob while
 * a native read of the same persisted record still returned the original file.
 * Do not disable caching globally, close shared connections or alter any row.
 */
async function committedPhoto(operationId: string): Promise<MediaDraftRecord | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = offlineDb.backendDB().transaction('mediaDrafts', 'readonly')
    const request = transaction.objectStore('mediaDrafts').getAll(operationId, 1)
    const timer = setTimeout(() => {
      reject(new TypeError('Saved photograph record read timed out'))
      try { transaction.abort() } catch { /* This readonly transaction already completed. */ }
    }, 5000)
    request.onsuccess = () => { clearTimeout(timer); resolve(request.result[0] as MediaDraftRecord | undefined) }
    request.onerror = () => { clearTimeout(timer); reject(request.error ?? new TypeError('Saved photograph record unavailable')) }
    transaction.onabort = () => { clearTimeout(timer); reject(transaction.error ?? new TypeError('Saved photograph record read interrupted')) }
  })
}

/** Materialize original bytes before writing upload-intent metadata. The upload
 * remains independent of later record rewrites, never a decoded/reencoded image.
 * Existing identity, immutable payload and claim checks remain authoritative.
 */
export async function materializeClaimedPhoto(expected: MediaDraftRecord): Promise<Blob> {
  if (await getActiveIdentityId() !== expected.identityId) throw new TypeError('Photo identity changed')
  const current = await committedPhoto(expected.operationId)
  if (!current || current.identityId !== expected.identityId || current.kabandaId !== expected.kabandaId ||
      current.raidId !== expected.raidId || current.status !== 'uploading' || current.attempts !== expected.attempts ||
      current.clientDraftId !== expected.clientDraftId || current.sourceSha256 !== expected.sourceSha256 ||
      current.sizeBytes !== expected.sizeBytes || current.contentType !== expected.contentType ||
      current.blob.size !== current.sizeBytes) throw new TypeError('Photo claim changed')
  const bytes = await readPhotoUploadBody(current.blob)
  if (await getActiveIdentityId() !== expected.identityId) throw new TypeError('Photo identity changed')
  return new Blob([bytes], { type: current.contentType })
}
