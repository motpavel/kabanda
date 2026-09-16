import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPrivateImageCache, isPrivateCover, loadPrivateCover, observeImageVisibility, setPrivateImageIdentity } from './CachedImage'

afterEach(() => {
  clearPrivateImageCache()
  setPrivateImageIdentity(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('identity-scoped cover memory', () => {
  it('only handles the authenticated cover and media routes, never arbitrary API or third-party media', () => {
    expect(isPrivateCover('/api/raid-templates/one/cover')).toBe(true)
    expect(isPrivateCover('/kabanda/api/raid-templates/one/cover')).toBe(true)
    expect(isPrivateCover('/api/raids/one/media/two/content')).toBe(true)
    expect(isPrivateCover('/api/raids/one/media/two/content?revision=abc')).toBe(true)
    expect(isPrivateCover('/api/raids/one/media/two')).toBe(false)
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
    expect(fetcher).toHaveBeenCalledWith(src, { cache: 'no-store', credentials: 'same-origin', signal: expect.any(AbortSignal) })
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


describe('private image scheduling', () => {
  it('bounds concurrent downloads and releases the next slot only after a response is consumed', async () => {
    setPrivateImageIdentity('member-a')
    const finish: Array<(response: Response) => void> = []
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish.push(resolve) }))
    vi.stubGlobal('fetch', fetcher)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cover')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const requests = [1, 2, 3, 4, 5].map(id => loadPrivateCover('member-a', `/api/raid-templates/${id}/cover`))
    expect(fetcher).toHaveBeenCalledTimes(3)
    const response = () => new Response(new Blob(['test'], { type: 'image/jpeg' }))
    finish[0]!(response())
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4))
    finish[1]!(response())
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5))
    for (const resolve of finish.slice(2)) resolve(response())
    await expect(Promise.all(requests)).resolves.toEqual(Array(5).fill('blob:cover'))
  })

  it('rejects queued downloads on logout before they reach the network', async () => {
    setPrivateImageIdentity('member-a')
    const fetcher = vi.fn((_input: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetcher)
    const requests = [1, 2, 3, 4].map(id => loadPrivateCover('member-a', `/api/raid-templates/${id}/cover`))
    const settled = Promise.allSettled(requests)
    expect(fetcher).toHaveBeenCalledTimes(3)
    setPrivateImageIdentity(null)
    expect((await settled).every(result => result.status === 'rejected')).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('waits for the viewport and disconnects the observer after visibility or disposal', () => {
    let intersect!: IntersectionObserverCallback
    const disconnect = vi.fn()
    const observe = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback }
      observe = observe
      disconnect = disconnect
    })
    const load = vi.fn()
    const element = {} as Element
    const dispose = observeImageVisibility(element, load)
    expect(observe).toHaveBeenCalledWith(element)
    expect(load).not.toHaveBeenCalled()
    intersect([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver)
    expect(load).not.toHaveBeenCalled()
    intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    expect(load).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
    dispose()
    expect(disconnect).toHaveBeenCalledTimes(2)
  })

  it('keeps images available on browsers without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const load = vi.fn()
    observeImageVisibility({} as Element, load)()
    expect(load).toHaveBeenCalledTimes(1)
  })
})
