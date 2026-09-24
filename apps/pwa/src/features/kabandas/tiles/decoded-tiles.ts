/** A small per-map reserve of decoded images. Object URLs let the SDK reuse
 * prepared images without another service-worker/IndexedDB round trip. */
export class DecodedTiles {
  private readonly entries = new Map<string, { url: string; image: HTMLImageElement; bytes: number; expires: number }>()
  private bytes = 0
  private disposed = false

  constructor(private readonly budget = 24 * 1024 * 1024) {}

  url(path: string): string {
    const entry = this.entries.get(path)
    if (!entry) return path
    if (entry.expires <= Date.now()) { this.remove(path); return path }
    this.entries.delete(path); this.entries.set(path, entry)
    return entry.url
  }

  async prepare(path: string, signal: AbortSignal): Promise<void> {
    if (this.disposed || signal.aborted || this.url(path) !== path) return
    const response = await fetch(`${path}&warm=1`, { signal, cache: 'no-store' })
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) return
    // An older worker cannot tell us the original tile's lifetime. Keep using
    // its regular path until the matching worker takes control.
    const expires = Math.min(Date.now() + 5 * 60_000, Number(response.headers.get('X-Kabanda-Tile-Expires')))
    if (!Number.isFinite(expires) || expires <= Date.now()) return
    const blob = await response.blob()
    if (signal.aborted || this.disposed) return
    const url = URL.createObjectURL(blob), image = new Image()
    image.src = url
    try {
      await image.decode()
      const bytes = image.naturalWidth * image.naturalHeight * 4 + blob.size
      if (signal.aborted || this.disposed || expires <= Date.now() || bytes > this.budget || !bytes) return
      this.remove(path)
      while (this.bytes + bytes > this.budget || this.entries.size >= 48) this.remove(this.entries.keys().next().value!)
      this.entries.set(path, { url, image, bytes, expires }); this.bytes += bytes
    } finally {
      if (this.entries.get(path)?.url !== url) { image.src = ''; URL.revokeObjectURL(url) }
    }
  }

  private remove(path: string) {
    const entry = this.entries.get(path)
    if (!entry) return
    this.entries.delete(path); this.bytes -= entry.bytes
    entry.image.src = ''; URL.revokeObjectURL(entry.url)
  }

  clear() { for (const path of this.entries.keys()) this.remove(path) }
  dispose() { this.disposed = true; this.clear() }
}
