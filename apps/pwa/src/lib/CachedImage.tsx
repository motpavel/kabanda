import { useEffect, useState, type ImgHTMLAttributes } from 'react'
import { IDENTITY_CHANGED_EVENT } from '../features/offline/ledger'

type Entry = { url: string; bytes: number }
const covers = new Map<string, Entry>()
const pending = new Map<string, Promise<string>>()
let identity: string | null = null
let generation = 0
const MAX_BYTES = 24 * 1024 * 1024
const MAX_ENTRIES = 64
const CACHE_CHANGED = 'kabanda:cover-cache-changed'

export function clearPrivateImageCache() {
  generation += 1
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
  return /^\/(?:kabanda\/)?api\/raid-templates\/[^/?#]+\/cover(?:\?[^#]*)?$/.test(src)
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
  const task = (async () => {
    const response = await fetch(src, { credentials: 'same-origin', cache: 'no-store' })
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
  })()
  pending.set(key, task)
  try { return await task } finally { if (pending.get(key) === task) pending.delete(key) }
}

export function CachedImage({ identityId, src, revision = '', fallbackSrc, ...props }: ImgHTMLAttributes<HTMLImageElement> & { identityId: string; src: string; revision?: string; fallbackSrc?: string }) {
  const privateCover = isPrivateCover(src)
  const key = keyFor(identityId, src, revision)
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(() => {
    const entry = identity === identityId ? covers.get(key) : undefined
    return entry ? { key, url: entry.url } : null
  })
  useEffect(() => {
    if (!privateCover) return
    let active = true
    const invalidate = () => { if (active) setLoaded(null) }
    window.addEventListener(CACHE_CHANGED, invalidate)
    void loadPrivateCover(identityId, src, revision).then((url) => {
      if (active) setLoaded({ key, url })
    }).catch(() => { if (active) setLoaded(fallbackSrc ? { key, url: fallbackSrc } : null) })
    return () => { active = false; window.removeEventListener(CACHE_CHANGED, invalidate) }
  }, [fallbackSrc, identityId, key, privateCover, revision, src])
  return <img {...props} src={privateCover ? (loaded?.key === key ? loaded.url : undefined) : src} />
}
