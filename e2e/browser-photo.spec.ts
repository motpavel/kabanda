import { expect, test } from './persistent-test.js'
import { installYandexMapsMock } from './support.js'
import type { RaidProjection } from '../apps/pwa/src/features/raids/types.js'

const userId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const raidId = '33333333-3333-4333-8333-333333333333'
const pointId = '44444444-4444-4444-8444-444444444444'
const raid: RaidProjection = { id: raidId, kabandaId: teamId, title: 'Подготовка фото', state: 'active', version: 1,
  scheduledAt: null, description: null, organizerUserId: userId, navigatorUserId: '55555555-5555-4555-8555-555555555555',
  navigatorReady: true, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  participants: [{ id: userId, displayName: 'Участник', avatarUrl: null, state: 'active' }], allowedActions: [],
  routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null } }

test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' })
test('selected PNG reaches the durable photo queue through the real browser decoder', async ({ page, context }, info) => {
  await installYandexMapsMock(context)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.addInitScript(() => {
    const diagnostic: string[] = []
    Object.assign(window, { photoPreparationSteps: diagnostic })
    if (typeof window.createImageBitmap === 'function') {
      const bitmap = window.createImageBitmap.bind(window)
      window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
        diagnostic.push('decode:start')
        return bitmap(...args).then(value => { diagnostic.push('decode:ok'); return value }, error => {
          diagnostic.push(`decode:${error.name}:${error.message}`); throw error
        })
      }) as typeof createImageBitmap
    } else diagnostic.push('decode:unavailable')
    const encode = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      diagnostic.push('encode:start')
      return encode.call(this, value => { diagnostic.push(value ? 'encode:ok' : 'encode:empty'); callback(value) }, type, quality)
    }
  })
  // A photo-decoder fixture must represent a confirmed personal visit now.
  // Real authorization and unvisited denial are tested against PostgreSQL.
  const photo = { pointSnapshotId: pointId, sourcePointId: pointId, name: 'Остановка', latitude: 56.86, longitude: 53.21,
    distanceMeters: 0, creditedByMe: true, creditedByTeam: true }
  let uploadRequests = 0
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/materials') && route.request().method() === 'POST') {
      uploadRequests++
      return route.fulfill({ status: 503, json: { error: { code: 'TEST_PHOTO', message: 'Synthetic upload pause' } } })
    }
    const body = path === '/api/me' ? { user: { id: userId, displayName: 'Участник', username: 'photo-qa', email: 'photo@example.test', identityKind: 'verified', avatarUrl: null } }
      : path === '/api/kabandas' ? { kabandas: [{ id: teamId, name: 'Фото', role: 'member', avatar: '🐗', coverImage: null, memberCount: 1, pointsCollectionId: null }] }
      : path.endsWith('/live') ? { raid, teamVisits: true, revision: '1', serverAt: new Date().toISOString(), claims: [], fallbacks: [], positions: [],
        points: [{ id: pointId, sourcePointId: pointId, name: 'Остановка', latitude: 56.86, longitude: 53.21, position: 0,
          visitedByMe: true, visitedByTeam: true, lastAttemptId: 'photo-fixture-visit', myLastVisitAttemptId: 'photo-fixture-visit',
          lastVisitedAt: '2026-09-19T12:00:00Z', lastVisitParticipantIds: [userId] }] }
      : path.endsWith('/materials') ? { materials: [], nextCursor: null, canWrite: true }
      : path.endsWith(`/points/${pointId}/history`) ? { pointId, personalCount: 1, visitors: [{ userId, displayName: 'Участник', count: 1 }], entries: [], nextOffset: null }
      : path.endsWith('/check-ins/nearby') ? { policy: { version: 'v1', radiusMeters: 50, maxAgeSeconds: 60, maxAccuracyMeters: 50 }, points: [photo] }
      : path.endsWith('/check-ins/presence') ? { pointSnapshotId: pointId, radiusMeters: 50, participants: [], serverAt: new Date().toISOString() }
      : path.endsWith('/presence/me') ? { radiusMeters: 50, maxAgeSeconds: 30, allReady: false, participants: [], serverAt: new Date().toISOString() }
      : path.endsWith('/raids') ? { raids: [raid] }
      : path.includes('templates') ? { templates: [], nextCursor: null }
      : path === `/api/raids/${raidId}` ? { raid } : {}
    return route.fulfill({ json: body })
  })
  await page.goto(`/app?raid=${raidId}`)
  await page.getByRole('button', { name: /^Остановка\./ }).click()
  const photoInput = page.locator('input[type="file"][aria-label="Добавить фото"]')
  try {
    await expect(photoInput).toBeAttached()
    await expect(photoInput).toBeEnabled()
    await photoInput.setInputFiles('apps/pwa/public/pwa-192x192.png')
    await expect.poll(async () => {
      if (uploadRequests > 0) return 'durably saved'
      return page.evaluate(() => JSON.stringify({ steps: (window as any).photoPreparationSteps,
        message: document.querySelector('.point-materials [role="alert"]')?.textContent ?? null }))
    }, { timeout: 15000 }).toBe('durably saved')
    expect(errors).toEqual([])
  } finally {
    await info.attach('photo-preparation-steps', { body: JSON.stringify({ errors, browser: await page.evaluate(() => ({
      steps: (window as any).photoPreparationSteps, message: document.querySelector('.point-materials [role="alert"]')?.textContent ?? null,
    })) }), contentType: 'application/json' })
  }
})

test('native image buffers survive a real IndexedDB round trip', async ({ page }, info) => {
  await page.route('**/photo-storage-probe', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><input type="file">' }))
  await page.goto('/photo-storage-probe')
  await page.locator('input').setInputFiles('apps/pwa/public/pwa-192x192.png')
  const report = await page.evaluate(async () => {
    const selected = document.querySelector('input')!.files![0]!
    const results: Record<string, string> = {}
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('synthetic-photo-probe', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('files')
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error)
    })
    async function roundTrip(name: string, value: Blob | ArrayBuffer) {
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('files', 'readwrite')
          transaction.objectStore('files').put(value, name)
          transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error)
          transaction.onerror = () => reject(transaction.error)
        })
        const saved = await new Promise<Blob | ArrayBuffer>((resolve, reject) => {
          const request = db.transaction('files').objectStore('files').get(name)
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
        })
        const before = new Uint8Array(value instanceof Blob ? await value.arrayBuffer() : value)
        const after = new Uint8Array(saved instanceof Blob ? await saved.arrayBuffer() : saved)
        results[name] = before.length === after.length && before.every((byte, i) => byte === after[i]) ? 'ok' : 'mismatched bytes'
      } catch (error) { results[name] = error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
    }
    try {
      const bytes = await selected.arrayBuffer()
      await roundTrip('buffer', bytes)
      await roundTrip('file', selected)
      await roundTrip('memory-blob', new Blob([bytes], { type: selected.type }))
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32
      canvas.getContext('2d')!.fillRect(0, 0, 32, 32)
      const generated = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('empty canvas')), 'image/jpeg'))
      await roundTrip('canvas-blob', generated)
      await roundTrip('copied-canvas-blob', new Blob([await generated.arrayBuffer()], { type: generated.type }))
    } finally { db.close() }
    return results
  })
  await info.attach('native-blob-persistence', { body: JSON.stringify(report), contentType: 'application/json' })
  expect(Object.values(report)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
})
