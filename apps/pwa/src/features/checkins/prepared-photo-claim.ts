import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import type { MediaDraftRecord } from '../offline/types'
import { claimNextMediaDraft, type CheckInSenderFence } from './store'
import { materializeClaimedPhoto } from './claimed-photo'

export type PreparedPhotoClaim = { media: MediaDraftRecord; uploadBlob: Blob | null; error: unknown }

function samePhoto(a: MediaDraftRecord, b: MediaDraftRecord): boolean {
  return a.operationId === b.operationId && a.identityId === b.identityId && a.kabandaId === b.kabandaId &&
    a.raidId === b.raidId && a.clientDraftId === b.clientDraftId && a.sourceSha256 === b.sourceSha256 &&
    a.sizeBytes === b.sizeBytes && a.contentType === b.contentType && a.caption === b.caption &&
    a.purpose === b.purpose && a.attemptId === b.attemptId && b.attempts === a.attempts + 1
}

/** Reading a pending file must precede ANY put of the record containing it,
 * including the transition to uploading. Keep local file I/O outside the write
 * transaction, so a slow disk cannot hold the identity/GPS stores locked.
 * The existing atomic claim remains mandatory before any API request.
 */
export async function claimPreparedPhoto(fence: CheckInSenderFence, issuedOnly = false): Promise<PreparedPhotoClaim | null> {
  if (await getActiveIdentityId() !== fence.identityId) return null
  const now = Date.now()
  const rows = await offlineDb.mediaDrafts.where('identityId').equals(fence.identityId)
    .filter(row => row.raidId === fence.raidId).toArray()
  const candidate = rows
    .filter(row => row.status === 'local' || row.status === 'intent' || row.status === 'retryable' ||
      (row.status === 'uploading' && row.claimUntil !== null && Date.parse(row.claimUntil) <= now))
    .filter(row => !issuedOnly || row.intentId !== null)
    .filter(row => !row.nextAttemptAt || Date.parse(row.nextAttemptAt) <= now)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  if (!candidate) return null
  let uploadBlob: Blob | null = null, error: unknown = null
  try { uploadBlob = await materializeClaimedPhoto(candidate) } catch (reason) { error = reason }
  // Revalidate the live fence and due operation AFTER the file read. If another
  // tab/session acquired ownership, the original claim returns null. A changed
  // candidate never borrows bytes from the previous one.
  const media = await claimNextMediaDraft(fence, Date.now(), issuedOnly)
  if (!media) return null
  if (!samePhoto(candidate, media)) return { media, uploadBlob: null, error: new TypeError('Prepared photo claim changed') }
  return { media, uploadBlob, error }
}
