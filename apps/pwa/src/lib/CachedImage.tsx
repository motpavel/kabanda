import { requestApi } from './api-transport'
import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import { IDENTITY_CHANGED_EVENT } from '../features/offline/ledger'

type Entry = { url: string; bytes: number }
const covers = new Map<string, Entry>()
const pending = new Map<string, Promise<string>>()
let identity: string | null = null
let generation = 0
const MAX_BYTES = 24 * 1024 * 1024
const MAX_ENTRIES = 64
const CACHE_CHANGED = 'kabanda:cover-cache-changed'
const MAX_DOWNLOADS = 3
let activeDownloads = 0
const downloadControllers = new Set<AbortController>()
const waitingDownloads: Array<() => void> = []

function withDownloadSlot<T>(signal: AbortSignal, download: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abortWaiting = () => {
      const index = waitingDownloads.indexOf(start)
      if (index !== -1) waitingDownloads.splice(index, 1)
      reject(signal.reason)
    }
    const start = () => {
      signal.removeEventListener('abort', abortWaiting)
      if (signal.aborted) { reject(signal.reason); return }
      activeDownloads += 1
      void download().then(resolve, reject).finally(() => {
        activeDownloads -= 1
        while (activeDownloads < MAX_DOWNLOADS && waitingDownloads.length) waitingDownloads.shift()!()
      })
    }
    if (signal.aborted) { reject(signal.reason); return }
    if (activeDownloads < MAX_DOWNLOADS) start()
    else {
      waitingDownloads.push(start)
      signal.addEventListener('abort', abortWaiting, { once: true })
    }
  })
}

/** Native loading=lazy cannot defer the authenticated fetch that creates a blob URL. */
export function observeImageVisibility(element: Element, load: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') { load(); return () => {} }
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load() }
  }, { rootMargin: '200px' })
  observer.observe(element)
  return () => observer.disconnect()
}

export function clearPrivateImageCache() {
  generation += 1
  for (const controller of downloadControllers) controller.abort(new Error('Image identity changed'))
  downloadControllers.clear()
  for (const entry of covers.values()) URL.revokeObjectURL(entry.url)
  covers.clear()
  pending.clear()
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CACHE_CHANGED))
}

export function setPrivateImageIdentity(next: string | null) {
  if (next !== identity) {
    identity = next
    clearPrivateImageCache()
  }
}

if (typeof window !== 'undefined') window.addEventListener(IDENTITY_CHANGED_EVENT, (event) => {
  setPrivateImageIdentity((event as CustomEvent<{ userId: string | null }>).detail.userId)
})

export function isPrivateCover(src: string): boolean {
  return /^\/(?:kabanda\/)?api\/(?:raid-templates\/[^/?#]+\/cover|raids\/[^/?#]+\/media\/[^/?#]+\/content)(?:\?[^#]*)?$/.test(src)
}

function keyFor(identityId: string, src: string, revision: string) { return JSON.stringify([identityId, src, revision]) }

/** Session memory only: never put permission-protected media into the service worker cache. */
export async function loadPrivateCover(identityId: string, src: string, revision = ''): Promise<string> {
  if (!isPrivateCover(src)) return src
  if (identity !== identityId) throw new Error('Image identity changed')
  const key = keyFor(identityId, src, revision)
  const hit = covers.get(key)
  if (hit) return hit.url
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const started = generation
  const controller = new AbortController()
  downloadControllers.add(controller)
  const task = withDownloadSlot(controller.signal, async () => {
    const response = await requestApi(src, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) clearPrivateImageCache()
      throw new Error('Cover unavailable')
    }
    const blob = await response.blob()
    if (started !== generation || identity !== identityId) throw new Error('Image identity changed')
    if (!blob.type.startsWith('image/') || blob.size > MAX_BYTES) throw new Error('Unsupported cover')
    let bytes = [...covers.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    while (covers.size && (covers.size >= MAX_ENTRIES || bytes + blob.size > MAX_BYTES)) {
      const first = covers.entries().next().value!
      URL.revokeObjectURL(first[1].url)
      covers.delete(first[0])
      bytes -= first[1].bytes
    }
    const url = URL.createObjectURL(blob)
    covers.set(key, { url, bytes: blob.size })
    return url
  })
  pending.set(key, task)
  try { return await task } finally { downloadControllers.delete(controller); if (pending.get(key) === task) pending.delete(key) }
}

export function CachedImage({ identityId, src, revision = '', fallbackSrc, ...props }: ImgHTMLAttributes<HTMLImageElement> & { identityId: string; src: string; revision?: string; fallbackSrc?: string }) {
  const privateCover = isPrivateCover(src)
  const key = keyFor(identityId, src, revision)
  const imageRef = useRef<HTMLImageElement>(null)
  const [visibleKey, setVisibleKey] = useState<string | null>(null)
  const mayLoad = props.loading !== 'lazy' || visibleKey === key || (identity === identityId && covers.has(key))
  useEffect(() => {
    if (!privateCover || mayLoad || !imageRef.current) return
    return observeImageVisibility(imageRef.current, () => setVisibleKey(key))
  }, [key, mayLoad, privateCover])
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(() => {
    const entry = identity === identityId ? covers.get(key) : undefined
    return entry ? { key, url: entry.url } : null
  })
  useEffect(() => {
    if (!privateCover || !mayLoad) return
    let active = true
    const invalidate = () => { if (active) setLoaded(null) }
    window.addEventListener(CACHE_CHANGED, invalidate)
    void loadPrivateCover(identityId, src, revision).then((url) => {
      if (active) setLoaded({ key, url })
    }).catch(() => { if (active) setLoaded(fallbackSrc ? { key, url: fallbackSrc } : null) })
    return () => { active = false; window.removeEventListener(CACHE_CHANGED, invalidate) }
  }, [fallbackSrc, identityId, key, mayLoad, privateCover, revision, src])
  return <img {...props} ref={imageRef} src={privateCover ? (loaded?.key === key ? loaded.url : undefined) : src} />
}
