import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import type { MediaDraftRecord } from '../offline/types'
import { readPhotoUploadBody } from './upload-body'

/** Open a short-lived read-only connection for the file read. In the failing
 * replay the application connection's Blob handle was unreadable, while a new
 * native connection read the original persisted bytes. Never close the shared
 * application database, change its schema, or publish an optimistic cached row.
 */
async function photoConnection(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let finished = false
    const request = indexedDB.open(offlineDb.name)
    const timer = setTimeout(() => { finished = true; reject(new TypeError('Saved photograph database open timed out')) }, 5000)
    request.onupgradeneeded = () => {
      // An absent database is not a reason to create a replacement one.
      request.transaction?.abort()
    }
    request.onsuccess = () => {
      clearTimeout(timer)
      if (finished) { request.result.close(); return }
      finished = true
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = () => {
      clearTimeout(timer)
      if (!finished) { finished = true; reject(request.error ?? new TypeError('Saved photograph database unavailable')) }
    }
  })
}

async function committedPhoto(db: IDBDatabase, operationId: string): Promise<MediaDraftRecord | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('mediaDrafts', 'readonly')
    const request = transaction.objectStore('mediaDrafts').getAll(operationId, 1)
    let row: MediaDraftRecord | undefined
    const timer = setTimeout(() => {
      reject(new TypeError('Saved photograph record read timed out'))
      try { transaction.abort() } catch { /* This readonly transaction already completed. */ }
    }, 5000)
    request.onsuccess = () => { row = request.result[0] as MediaDraftRecord | undefined }
    request.onerror = () => { clearTimeout(timer); reject(request.error ?? new TypeError('Saved photograph record unavailable')) }
    // Do not start the external binary read inside a live IDB transaction.
    transaction.oncomplete = () => { clearTimeout(timer); resolve(row) }
    transaction.onabort = () => { clearTimeout(timer); reject(transaction.error ?? new TypeError('Saved photograph record read interrupted')) }
  })
}

/** Materialize original bytes before writing upload-intent metadata. The upload
 * remains independent of later record rewrites, never a decoded/reencoded image.
 * Existing identity, immutable payload and claim checks remain authoritative.
 */
export async function materializeClaimedPhoto(expected: MediaDraftRecord): Promise<Blob> {
  if (await getActiveIdentityId() !== expected.identityId) throw new TypeError('Photo identity changed')
  const connection = await photoConnection()
  try {
    const current = await committedPhoto(connection, expected.operationId)
    if (!current || current.identityId !== expected.identityId || current.kabandaId !== expected.kabandaId ||
        current.raidId !== expected.raidId || current.status !== 'uploading' || current.attempts !== expected.attempts ||
        current.clientDraftId !== expected.clientDraftId || current.sourceSha256 !== expected.sourceSha256 ||
        current.sizeBytes !== expected.sizeBytes || current.contentType !== expected.contentType ||
        current.blob.size !== current.sizeBytes) throw new TypeError('Photo claim changed')
    const bytes = await readPhotoUploadBody(current.blob)
    if (await getActiveIdentityId() !== expected.identityId) throw new TypeError('Photo identity changed')
    return new Blob([bytes], { type: current.contentType })
  } finally { connection.close() }
}
