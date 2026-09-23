import Dexie, { type EntityTable } from 'dexie'

type ViewedMedia = { key: string; bytes: ArrayBuffer; contentType: string; sizeBytes: number; savedAt: number }
const db = new Dexie('kabanda-viewed-media') as Dexie & { covers: EntityTable<ViewedMedia, 'key'> }
db.version(1).stores({ covers: 'key, savedAt, sizeBytes' })
const MAX_BYTES = 32 * 1024 * 1024
const MAX_AGE = 7 * 24 * 60 * 60 * 1000

// Only images referenced by an account-scoped view are eligible. Keys contain
// identity, content URL and immutable material creation time. No prefetch of bytes.
export async function readViewedMedia(key: string): Promise<Blob | undefined> {
  try {
    const entry = await db.covers.get(key)
    return entry && entry.bytes instanceof ArrayBuffer && Date.now() - entry.savedAt < MAX_AGE
      ? new Blob([entry.bytes], { type: entry.contentType }) : undefined
  } catch { return undefined }
}

export async function saveViewedMedia(key: string, blob: Blob, valid: () => boolean): Promise<void> {
  try {
    if (!valid() || blob.size > MAX_BYTES) return
    // WebKit can reject Blob/File persistence even when IndexedDB itself works.
    // Convert before opening the transaction, then check the identity fence again.
    const bytes = await blob.arrayBuffer()
    await db.transaction('rw', db.covers, async () => {
      if (!valid()) return
      await db.covers.put({ key, bytes, contentType: blob.type, sizeBytes: bytes.byteLength, savedAt: Date.now() })
      // Eviction reads index metadata, not every saved image back into memory.
      const expired = await db.covers.where('savedAt').below(Date.now() - MAX_AGE).primaryKeys()
      await db.covers.bulkDelete(expired)
      const count = await db.covers.count()
      if (count > 64) await db.covers.bulkDelete(await db.covers.orderBy('savedAt').limit(count - 64).primaryKeys())
      const sizes = await db.covers.orderBy('sizeBytes').keys()
      let totalBytes = sizes.reduce<number>((sum, size) => sum + Number(size), 0)
      while (totalBytes > MAX_BYTES) {
        const oldest = await db.covers.orderBy('savedAt').first()
        if (!oldest) break
        await db.covers.delete(oldest.key)
        totalBytes -= oldest.sizeBytes
      }
    })
  } catch { /* Storage denial/quota must never prevent viewing a photo. */ }
}

export async function clearViewedMedia(): Promise<void> {
  try { await db.covers.clear() } catch { /* Cache is optional. */ }
}
