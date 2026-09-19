import type { Page, TestInfo } from '@playwright/test'

/** Read-only diagnostics for disposable fixtures. Report sizes and error names,
 * never bytes, capabilities, cookies, coordinates or private image content. */
export async function savedPhotoProbe(page: Page, info: TestInfo) {
  const result = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kabanda-offline')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    async function bounded(read: () => Promise<ArrayBuffer | string | null>) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const value = await Promise.race([read(), new Promise<string>(resolve => {
          timer = setTimeout(() => resolve('read-timeout'), 1500)
        })])
        return value instanceof ArrayBuffer ? value.byteLength : typeof value === 'string'
          ? value.startsWith('data:') ? `data-url:${value.length}` : value : null
      } catch (e) { return e instanceof Error ? `${e.name}:${e.message}` : 'read-failed' }
      finally { clearTimeout(timer) }
    }
    try {
      if (!db.objectStoreNames.contains('mediaDrafts')) return { noStore: true }
      const rows = await new Promise<any[]>((resolve, reject) => {
        const read = db.transaction('mediaDrafts').objectStore('mediaDrafts').getAll()
        read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error)
      })
      return { online: navigator.onLine, steps: (window as any).offlinePhotoSteps ?? [],
        rows: await Promise.all(rows.filter(row => row.status !== 'accepted').map(async row => ({
          status: row.status, attempts: row.attempts, error: row.lastErrorCode,
          intent: !!row.intentId, declared: row.sizeBytes, size: row.blob.size, type: row.blob.type,
          arrayBuffer: await bounded(() => row.blob.arrayBuffer()),
          fileReader: await bounded(() => new Promise((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(reader.result)
            reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(row.blob)
          })),
        }))) }
    } finally { db.close() }
  })
  await info.attach('saved-photo-native-read', { body: JSON.stringify(result), contentType: 'application/json' })
}
