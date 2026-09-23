import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { clearViewedMedia, readViewedMedia, saveViewedMedia } from './viewed-media-store'
import { clearPrivateImageCache, loadPrivateCover, setPrivateImageIdentity } from './CachedImage'
afterEach(async () => { setPrivateImageIdentity(null); await clearViewedMedia(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('reuses a viewed photo after document memory reset, isolates accounts and clears on denial', async () => {
  setPrivateImageIdentity('alice')
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const fetcher = vi.fn(async () => new Response(new Blob(['photo'], { type: 'image/jpeg' })))
  vi.stubGlobal('fetch', fetcher)
  const path = '/api/raids/one/points/two/materials/three/content'
  await loadPrivateCover('alice', path, 'created-at', false, true)
  clearPrivateImageCache(false)
  await loadPrivateCover('alice', path, 'created-at', false, true)
  expect(fetcher).toHaveBeenCalledTimes(1)
  clearPrivateImageCache()
  await loadPrivateCover('alice', path, 'created-at', false, true)
  expect(fetcher).toHaveBeenCalledTimes(2)
  setPrivateImageIdentity('bob')
  await loadPrivateCover('bob', path, 'created-at', false, true)
  expect(fetcher).toHaveBeenCalledTimes(3)
})
it('bounds stored photos, expires them and ignores invalidated writes', async () => {
  const blob = new Blob(['photo'], { type: 'image/jpeg' })
  await saveViewedMedia('fenced', blob, () => false)
  expect(await readViewedMedia('fenced')).toBeUndefined()
  for (let i = 0; i < 65; i++) await saveViewedMedia(String(i), blob, () => true)
  expect(await readViewedMedia('0')).toBeUndefined()
  expect(await readViewedMedia('64')).toBeDefined()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 86_400_000)
  expect(await readViewedMedia('64')).toBeUndefined()
})
