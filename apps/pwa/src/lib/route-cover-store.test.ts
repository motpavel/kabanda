import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { clearRouteCovers, readRouteCover, saveRouteCover } from './route-cover-store'
import { clearPrivateImageCache, loadPrivateCover, setPrivateImageIdentity } from './CachedImage'

afterEach(async () => {
  setPrivateImageIdentity(null)
  await clearRouteCovers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('reuses authorized catalog bytes after memory reset, but refetches a changed revision', async () => {
  setPrivateImageIdentity('alice')
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cover')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const fetcher = vi.fn(async () => new Response(new Blob(['cover'], { type: 'image/jpeg' })))
  vi.stubGlobal('fetch', fetcher)
  const src = '/api/raid-templates/one/cover'
  await loadPrivateCover('alice', src, 'revision1', true)
  clearPrivateImageCache(false)
  await loadPrivateCover('alice', src, 'revision1', true)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await loadPrivateCover('alice', src, 'revision2', true)
  expect(fetcher).toHaveBeenCalledTimes(2)
  setPrivateImageIdentity('bob')
  await loadPrivateCover('bob', src, 'revision1', true)
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('does not reuse persistent bytes without a catalog authorization or after logout', async () => {
  setPrivateImageIdentity('alice')
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cover')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const fetcher = vi.fn(async () => new Response(new Blob(['cover'], { type: 'image/jpeg' })))
  vi.stubGlobal('fetch', fetcher)
  const src = '/api/raid-templates/one/cover'
  await loadPrivateCover('alice', src, 'revision1', true)
  clearPrivateImageCache(false)
  await loadPrivateCover('alice', src, 'revision1')
  expect(fetcher).toHaveBeenCalledTimes(2)
  setPrivateImageIdentity(null)
  setPrivateImageIdentity('alice')
  await loadPrivateCover('alice', src, 'revision1', true)
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('ignores fenced writes and expires old entries', async () => {
  const blob = new Blob(['cover'], { type: 'image/jpeg' })
  await saveRouteCover('invalid', blob, () => false)
  expect(await readRouteCover('invalid')).toBeUndefined()
  await saveRouteCover('old', blob, () => true)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 86_400_000)
  expect(await readRouteCover('old')).toBeUndefined()
})
