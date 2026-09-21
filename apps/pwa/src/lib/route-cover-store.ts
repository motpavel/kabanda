import Dexie, { type EntityTable } from 'dexie'

type Cover = { key: string; blob: Blob; savedAt: number }
const db = new Dexie('kabanda-route-covers') as Dexie & { covers: EntityTable<Cover, 'key'> }
db.version(1).stores({ covers: 'key, savedAt' })
const MAX_BYTES = 24 * 1024 * 1024
const MAX_AGE = 7 * 24 * 60 * 60 * 1000

// Only callers with a freshly authorized catalog may reuse these bytes.
// Keys include account, URL and server content hash. Never cache raid photos.
export async function readRouteCover(key: string): Promise<Blob | undefined> {
  try {
    const entry = await db.covers.get(key)
    return entry && Date.now() - entry.savedAt < MAX_AGE ? entry.blob : undefined
  } catch { return undefined }
}

export async function saveRouteCover(key: string, blob: Blob, valid: () => boolean): Promise<void> {
  try {
    await db.transaction('rw', db.covers, async () => {
      if (!valid() || blob.size > MAX_BYTES) return
      await db.covers.put({ key, blob, savedAt: Date.now() })
      const entries = await db.covers.orderBy('savedAt').toArray()
      let bytes = entries.reduce((sum, entry) => sum + entry.blob.size, 0)
      let count = entries.length
      for (const entry of entries) {
        if (bytes <= MAX_BYTES && count <= 64 && Date.now() - entry.savedAt < MAX_AGE) break
        await db.covers.delete(entry.key)
        bytes -= entry.blob.size
        count -= 1
      }
    })
  } catch { /* Storage denial/quota must never prevent viewing a route. */ }
}

export async function clearRouteCovers(): Promise<void> {
  try { await db.covers.clear() } catch { /* Cache is optional. */ }
}
