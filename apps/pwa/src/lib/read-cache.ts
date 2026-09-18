/** In-memory reads only: identity changes and mutations fence every cached value. */
export class ReadCache {
  private values = new Map<string, { value: unknown; savedAt: number }>()
  private pending = new Map<string, Promise<unknown>>()
  private generation = 0
  private identityGeneration = 0
  private mutations = 0

  evict(matches: (key: string) => boolean) {
    for (const key of this.values.keys()) if (matches(key)) this.values.delete(key)
    for (const key of this.pending.keys()) if (matches(key)) this.pending.delete(key)
  }

  /** Fence consumer state and persistence with the same generation as reads. */
  fence(): () => boolean {
    const generation = this.generation
    return () => generation === this.generation
  }

  invalidate(identityChanged = false) {
    this.generation += 1
    if (identityChanged) this.identityGeneration += 1
    this.values.clear()
    this.pending.clear()
  }

  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.mutations += 1
    this.invalidate()
    try { return await operation() }
    finally { this.mutations -= 1; this.invalidate() }
  }

  async read<T>(key: string, operation: () => Promise<T>, maxAgeMs = 0): Promise<T> {
    const value = this.values.get(key)
    if (maxAgeMs > 0 && value && Date.now() - value.savedAt < maxAgeMs) return structuredClone(value.value) as T
    let pending = this.pending.get(key) as Promise<T> | undefined
    if (!pending) {
      const generation = this.generation
      const identityGeneration = this.identityGeneration
      pending = Promise.resolve().then(operation).then((value) => {
        if (identityGeneration !== this.identityGeneration) throw new TypeError('Identity changed during read')
        if (generation === this.generation && this.pending.get(key) === pending && this.mutations === 0 && maxAgeMs > 0) {
          // Keep a bounded session cache even when browsing many raids.
          if (this.values.size >= 100) this.values.delete(this.values.keys().next().value!)
          this.values.set(key, { value: structuredClone(value), savedAt: Date.now() })
        }
        return value
      }, (error: unknown) => {
        // A late 401 from an old login must not log out the current account.
        if (identityGeneration !== this.identityGeneration) throw new TypeError('Identity changed during read')
        throw error
      })
      this.pending.set(key, pending)
      void pending.finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key) }).catch(() => undefined)
    }
    return structuredClone(await pending)
  }
}
