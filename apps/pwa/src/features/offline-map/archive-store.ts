import Dexie, { type EntityTable } from 'dexie'

export type CityArchiveSpec = { version: string; url: string; bytes: number; sha256: string }
export type CachedCityArchive = { spec: CityArchiveSpec; blob: Blob; savedAt: number }
export type CityArchiveSnapshot = {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  version: string | null
  cachedVersion: string | null
  downloadedBytes: number
  totalBytes: number
  /** Percentage between 0 and 100. */
  progress: number
  error: string | null
}

type ArchiveRow = CachedCityArchive & { key: 'city' }
type ArchiveDatabase = Dexie & { archives: EntityTable<ArchiveRow, 'key'> }
type StorageAccess = Pick<StorageManager, 'estimate' | 'persist'>
type StoreOptions = {
  databaseName?: string
  fetcher?: typeof fetch
  storage?: StorageAccess
  online?: () => boolean
  saveData?: () => boolean
  origin?: string
}
type Flight = { key: string; controller: AbortController; promise: Promise<Blob | null> }

export const MAX_CITY_ARCHIVE_BYTES = 80 * 1024 * 1024
const MIN_FREE_HEADROOM = 8 * 1024 * 1024
const initialSnapshot: CityArchiveSnapshot = {
  status: 'idle', version: null, cachedVersion: null, downloadedBytes: 0,
  totalBytes: 0, progress: 0, error: null,
}

function sameArchive(a: CityArchiveSpec, b: CityArchiveSpec): boolean {
  return a.version === b.version && a.bytes === b.bytes && a.sha256.toLowerCase() === b.sha256.toLowerCase()
}

function abortIfNeeded(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Загрузка отменена', 'AbortError')
}

function failureMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : null
  if (name === 'QuotaExceededError') return 'Недостаточно места для карты. Освободите память и повторите загрузку.'
  if (name === 'AbortError') return 'Загрузка карты отменена.'
  return error instanceof Error ? error.message : 'Не удалось сохранить карту. Можно повторить загрузку.'
}

/** The archive is public cartography; it intentionally survives account changes. */
export function createCityArchiveStore(options: StoreOptions = {}) {
  const db = new Dexie(options.databaseName ?? 'kabanda-city-map') as ArchiveDatabase
  db.version(1).stores({ archives: 'key' })
  const listeners = new Set<() => void>()
  const automaticFailures = new Set<string>()
  let snapshot = initialSnapshot
  let flight: Flight | null = null

  const emit = (next: Partial<CityArchiveSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }
  const storage = () => options.storage ?? (typeof navigator === 'undefined' ? undefined : navigator.storage)
  const online = () => options.online?.() ?? (typeof navigator === 'undefined' || navigator.onLine !== false)
  const saveData = () => options.saveData?.() ?? (typeof navigator !== 'undefined'
    && Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData))

  async function read(spec?: CityArchiveSpec): Promise<CachedCityArchive | null> {
    try {
      const row = await db.archives.get('city')
      if (!row || row.blob.size !== row.spec.bytes || (spec && !sameArchive(row.spec, spec))) return null
      return { spec: row.spec, blob: row.blob, savedAt: row.savedAt }
    } catch { return null }
  }

  function validatedUrl(spec: CityArchiveSpec) {
    if (!spec.version || !Number.isSafeInteger(spec.bytes) || spec.bytes <= 0 || spec.bytes > MAX_CITY_ARCHIVE_BYTES
      || !/^[a-f0-9]{64}$/i.test(spec.sha256)) {
      throw new Error('Файл карты не прошёл проверку. Попробуйте обновить приложение.')
    }
    const origin = options.origin ?? (typeof location === 'undefined' ? 'https://localhost' : location.origin)
    const url = new URL(spec.url, origin)
    if (url.origin !== origin || !/^https?:$/.test(url.protocol)) throw new Error('Неверный адрес файла карты.')
    return url.href
  }

  async function download(spec: CityArchiveSpec, manual: boolean, controller: AbortController): Promise<Blob | null> {
    const signal = controller.signal
    const key = `${spec.version}:${spec.sha256}:${spec.bytes}`
    const update = (next: Partial<CityArchiveSnapshot>) => { if (!signal.aborted) emit(next) }
    try {
      const url = validatedUrl(spec)
      update({ status: 'checking', version: spec.version, downloadedBytes: 0, totalBytes: spec.bytes, progress: 0, error: null })
      const cached = await read()
      abortIfNeeded(signal)
      update({ cachedVersion: cached?.spec.version ?? null })
      if (cached && sameArchive(cached.spec, spec)) {
        update({ status: 'ready', downloadedBytes: spec.bytes, progress: 100 })
        return cached.blob
      }
      if (!online() || (!manual && saveData())) {
        update({ status: 'idle' })
        return null
      }
      const availableStorage = storage()
      if (availableStorage?.estimate) {
        // Some webviews deny estimates while still allowing IndexedDB writes.
        const estimate = await availableStorage.estimate().catch(() => null)
        abortIfNeeded(signal)
        const free = estimate?.quota === undefined ? undefined : estimate.quota - (estimate.usage ?? 0)
        if (free !== undefined && free < spec.bytes + Math.max(MIN_FREE_HEADROOM, spec.bytes * .1)) {
          throw new DOMException('Недостаточно места для карты', 'QuotaExceededError')
        }
      }
      update({ status: 'downloading' })
      const response = await (options.fetcher ?? fetch)(url, { signal, credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error('Не удалось загрузить карту. Проверьте соединение и повторите загрузку.')
      const declaredLength = response.headers.get('content-length')
      if (declaredLength && Number(declaredLength) !== spec.bytes) throw new Error('Размер карты изменился. Попробуйте обновить приложение.')
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Не удалось прочитать файл карты. Повторите загрузку.')
      const cancelReader = () => { void reader.cancel().catch(() => {}) }
      signal.addEventListener('abort', cancelReader, { once: true })
      const chunks: ArrayBuffer[] = []
      let received = 0
      let lastProgressTime = 0
      try {
        while (true) {
          abortIfNeeded(signal)
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > spec.bytes) throw new Error('Размер карты не совпадает. Повторите загрузку.')
          chunks.push(value.slice().buffer)
          const now = Date.now()
          if (now - lastProgressTime >= 120 || received === spec.bytes) {
            update({ downloadedBytes: received, progress: Math.min(99, received / spec.bytes * 100) })
            lastProgressTime = now
          }
        }
      } catch (error) {
        await reader.cancel().catch(() => {})
        throw error
      } finally {
        signal.removeEventListener('abort', cancelReader)
        reader.releaseLock()
      }
      abortIfNeeded(signal)
      if (received !== spec.bytes) throw new Error('Карта загрузилась не полностью. Повторите загрузку.')
      const blob = new Blob(chunks, { type: 'application/octet-stream' })
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      if (hash !== spec.sha256.toLowerCase()) throw new Error('Файл карты повреждён. Повторите загрузку.')
      abortIfNeeded(signal)
      // Replace only a complete, verified download. Aborted writes roll back to the old archive.
      await db.transaction('rw', db.archives, async () => {
        abortIfNeeded(signal)
        await db.archives.put({ key: 'city', spec: { ...spec }, blob, savedAt: Date.now() })
        abortIfNeeded(signal)
      })
      abortIfNeeded(signal)
      update({ status: 'ready', cachedVersion: spec.version, downloadedBytes: spec.bytes, progress: 100 })
      if (availableStorage?.persist) void Promise.resolve().then(() => availableStorage.persist()).catch(() => false)
      automaticFailures.delete(key)
      return blob
    } catch (error) {
      automaticFailures.add(key)
      update({ status: 'error', error: failureMessage(error) })
      return null
    }
  }

  function ensure(spec: CityArchiveSpec, { manual = false }: { manual?: boolean } = {}): Promise<Blob | null> {
    const key = `${spec.version}:${spec.sha256}:${spec.bytes}`
    if (flight?.key === key) return flight.promise
    if (!manual && automaticFailures.has(key)) return read(spec).then(cached => cached?.blob ?? null)
    flight?.controller.abort()
    const controller = new AbortController()
    // Defer the run so even immediate subscriber callbacks see the deduplicated flight.
    const promise = Promise.resolve().then(() => download({ ...spec }, manual, controller)).finally(() => {
      if (flight?.controller === controller) flight = null
    })
    flight = { key, controller, promise }
    return promise
  }

  return {
    read,
    ensure,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    cancel() {
      if (!flight) return
      automaticFailures.add(flight.key)
      flight.controller.abort()
      flight = null
      emit({ status: 'idle', error: null })
    },
  }
}

export const cityArchiveStore = createCityArchiveStore()
