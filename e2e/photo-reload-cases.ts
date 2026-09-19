import { test, expect } from './persistent-test.js'

test('native stored image bytes remain readable after metadata rewrites and reload', async ({ page }, info) => {
  await page.route('**/photo-reload-probe', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><input type="file">' }))
  await page.goto('/photo-reload-probe')
  await page.locator('input').setInputFiles('apps/pwa/public/pwa-192x192.png')
  const expected = await page.evaluate(async () => {
    const selected = document.querySelector('input')!.files![0]!
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32
    canvas.getContext('2d')!.fillRect(0, 0, 32, 32)
    const generated = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('empty canvas')), 'image/jpeg'))
    const values: Record<string, Blob | ArrayBuffer> = { file: selected, canvas: generated,
      memory: new Blob([await generated.arrayBuffer()], { type: generated.type }), buffer: await generated.arrayBuffer() }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('synthetic-photo-reload', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('files')
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error)
    })
    const sizes: Record<string, number> = {}
    try {
      for (const [key, value] of Object.entries(values)) {
        sizes[key] = value instanceof Blob ? value.size : value.byteLength
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('files', 'readwrite')
          transaction.objectStore('files').put({ blob: value, status: 'local' }, key)
          transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error)
        })
      }
    } finally { db.close() }
    return sizes
  })
  await page.reload()
  const observed = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('synthetic-photo-reload')
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error)
    })
    const output: Record<string, Record<string, number | string>> = {}
    const read = async (blob: Blob | ArrayBuffer): Promise<number | string> => {
      if (blob instanceof ArrayBuffer) return blob.byteLength
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([blob.arrayBuffer().then(bytes => bytes.byteLength),
          new Promise<string>(resolve => { timer = setTimeout(() => resolve('read-timeout'), 1500) })])
      } catch (e) { return e instanceof Error ? `${e.name}:${e.message}` : 'read-failed' }
      finally { clearTimeout(timer) }
    }
    try {
      for (const key of ['file', 'canvas', 'memory', 'buffer']) {
        const row = await new Promise<any>((resolve, reject) => {
          const request = db.transaction('files').objectStore('files').get(key)
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
        })
        output[key] = { beforePut: await read(row.blob) }
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('files', 'readwrite')
          transaction.objectStore('files').put({ ...row, status: 'uploading' }, key)
          transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error)
        })
        output[key]!.oldAfterPut = await read(row.blob)
        const updated = await new Promise<any>((resolve, reject) => {
          const request = db.transaction('files').objectStore('files').get(key)
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
        })
        output[key]!.currentAfterPut = await read(updated.blob)
      }
    } finally { db.close() }
    return output
  })
  await info.attach('native-reload-and-rewrite', { body: JSON.stringify({ expected, observed }), contentType: 'application/json' })
  for (const [key, size] of Object.entries(expected)) {
    expect(observed[key], key).toEqual({ beforePut: size, oldAfterPut: size, currentAfterPut: size })
  }
})
