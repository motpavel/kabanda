import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPrivateImageCache, isPrivateCover, loadPrivateCover, setPrivateImageIdentity } from './CachedImage'

afterEach(() => {
  clearPrivateImageCache()
  setPrivateImageIdentity(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('identity-scoped cover memory', () => {
  it('only handles the authenticated template cover route, never arbitrary API or third-party media', () => {
    expect(isPrivateCover('/api/raid-templates/one/cover')).toBe(true)
    expect(isPrivateCover('/kabanda/api/raid-templates/one/cover')).toBe(true)
    expect(isPrivateCover('/api/me')).toBe(false)
    expect(isPrivateCover('https://external.test/api/raid-templates/one/cover')).toBe(false)
    expect(isPrivateCover('/brand/home.jpg')).toBe(false)
  })

  it('deduplicates downloads and revokes private blobs on explicit invalidation', async () => {
    setPrivateImageIdentity('member-a')
    const fetcher = vi.fn(async () => new Response(new Blob(['test'], { type: 'image/jpeg' })))
    vi.stubGlobal('fetch', fetcher)
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cover-one')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const src = '/api/raid-templates/one/cover'
    expect(await Promise.all([loadPrivateCover('member-a', src), loadPrivateCover('member-a', src)])).toEqual(['blob:cover-one', 'blob:cover-one'])
    expect(await loadPrivateCover('member-a', src)).toBe('blob:cover-one')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(src, { cache: 'no-store', credentials: 'same-origin' })
    expect(create).toHaveBeenCalledTimes(1)
    await expect(loadPrivateCover('member-b', src)).rejects.toThrow('identity changed')
    clearPrivateImageCache()
    expect(revoke).toHaveBeenCalledWith('blob:cover-one')
  })

  it('does not resurrect a private cover if logout/invalidation happens during download', async () => {
    setPrivateImageIdentity('member-a')
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const create = vi.spyOn(URL, 'createObjectURL')
    const request = loadPrivateCover('member-a', '/api/raid-templates/racing/cover')
    setPrivateImageIdentity(null)
    finish(new Response(new Blob(['test'], { type: 'image/jpeg' })))
    await expect(request).rejects.toThrow('identity changed')
    expect(create).not.toHaveBeenCalled()
    await expect(loadPrivateCover('member-a', '/api/raid-templates/racing/cover')).rejects.toThrow('identity changed')
  })
})
