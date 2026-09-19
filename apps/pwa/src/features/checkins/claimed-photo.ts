import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import type { MediaDraftRecord } from '../offline/types'
import { readPhotoUploadBody } from './upload-body'

/** Read the CURRENT stored value after claim, before rememberMediaIntent puts
 * that record again. A Blob returned before a record rewrite can refer to an
 * obsolete file backing in WebKit. Materializing here also keeps the upload
 * independent of subsequent receipt metadata writes. No record is altered.
 */
export async function materializeClaimedPhoto(expected: MediaDraftRecord): Promise<Blob> {
  if (await getActiveIdentityId() !== expected.identityId) throw new TypeError('Photo identity changed')
  const current = await offlineDb.mediaDrafts.get(expected.operationId)
  if (!current || current.identityId !== expected.identityId || current.raidId !== expected.raidId ||
      current.status !== 'uploading' || current.attempts !== expected.attempts ||
      current.clientDraftId !== expected.clientDraftId || current.sourceSha256 !== expected.sourceSha256 ||
      current.sizeBytes !== expected.sizeBytes || current.contentType !== expected.contentType ||
      current.blob.size !== current.sizeBytes) throw new TypeError('Photo claim changed')
  const bytes = await readPhotoUploadBody(current.blob)
  if (await getActiveIdentityId() !== expected.identityId) throw new TypeError('Photo identity changed')
  return new Blob([bytes], { type: current.contentType })
}
