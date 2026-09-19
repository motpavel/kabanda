import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import type { MediaDraftRecord } from '../offline/types'
import { readPhotoUploadBody } from './upload-body'

/** Read the CURRENT stored value after claim, before rememberMediaIntent puts
 * that record again. Materializing here makes the network upload independent
 * of subsequent receipt metadata writes. No persisted record is altered.
 */
export async function materializeClaimedPhoto(expected: MediaDraftRecord): Promise<Blob> {
  if (await getActiveIdentityId() !== expected.identityId) throw new TypeError('Photo identity changed')
  // Use a bounded primary-key collection (native getAll), not an unbounded
  // gallery read. In the failing WebKit replay, single-record get() returned a
  // Blob whose read repeatedly failed, while getAll() of the same store yielded
  // the original readable bytes. Keep the exact-key and claim checks intact.
  const matches = await offlineDb.mediaDrafts.where('operationId').equals(expected.operationId).toArray()
  const current = matches.length === 1 ? matches[0] : undefined
  if (!current || current.identityId !== expected.identityId || current.raidId !== expected.raidId ||
      current.status !== 'uploading' || current.attempts !== expected.attempts ||
      current.clientDraftId !== expected.clientDraftId || current.sourceSha256 !== expected.sourceSha256 ||
      current.sizeBytes !== expected.sizeBytes || current.contentType !== expected.contentType ||
      current.blob.size !== current.sizeBytes) throw new TypeError('Photo claim changed')
  const bytes = await readPhotoUploadBody(current.blob)
  if (await getActiveIdentityId() !== expected.identityId) throw new TypeError('Photo identity changed')
  return new Blob([bytes], { type: current.contentType })
}
