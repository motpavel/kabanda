import { expect, type Page } from '@playwright/test'

type SavedPhoto = { operationId: string; sourceSha256: string; sizeBytes: number; contentType: string }
export async function failNextSavedPhotoRead(page: Page): Promise<SavedPhoto> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kabanda-offline')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    let photo: SavedPhoto | undefined
    try {
      photo = await new Promise<SavedPhoto | undefined>((resolve, reject) => {
        const request = db.transaction('mediaDrafts').objectStore('mediaDrafts').getAll()
        request.onsuccess = () => resolve(request.result.find(row => row.status === 'local'))
        request.onerror = () => reject(request.error)
      })
    } finally { db.close() }
    if (!photo) throw new Error('Missing durable legacy photograph')
    const { operationId, sourceSha256, sizeBytes, contentType } = photo
    const original = Blob.prototype.arrayBuffer
    const evidence = { injected: 0, nativeReads: 0 }
    Object.assign(window, { legacyPhotoReadFault: evidence })
    Blob.prototype.arrayBuffer = function () {
      if (navigator.onLine && this.size === sizeBytes && this.type === contentType) {
        if (evidence.injected === 0) {
          evidence.injected++
          return Promise.reject(new DOMException('Synthetic temporary saved-file failure', 'NotFoundError'))
        }
        evidence.nativeReads++
      }
      // All recovery reads use the real browser Blob and IndexedDB bytes.
      return original.call(this)
    }
    return { operationId, sourceSha256, sizeBytes, contentType }
  })
}

export async function expectSavedPhotoRecovered(page: Page, expected: SavedPhoto) {
  const observed = await page.evaluate(async operationId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kabanda-offline')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    try {
      const row = await new Promise<any>((resolve, reject) => {
        const request = db.transaction('mediaDrafts').objectStore('mediaDrafts').get(operationId)
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      return { fault: (window as any).legacyPhotoReadFault,
        photo: row ? { operationId: row.operationId, sourceSha256: row.sourceSha256, sizeBytes: row.sizeBytes,
          contentType: row.contentType, status: row.status, attempts: row.attempts, mediaId: row.mediaId } : null }
    } finally { db.close() }
  }, expected.operationId)
  expect(observed.fault.injected).toBe(1)
  expect(observed.fault.nativeReads).toBeGreaterThan(0)
  expect(observed.photo).toMatchObject({ ...expected, status: 'accepted' })
  expect(observed.photo!.attempts).toBeGreaterThanOrEqual(2)
  expect(observed.photo!.mediaId).toBeTruthy()
}
