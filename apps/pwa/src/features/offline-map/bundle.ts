import type { CityArchiveSpec } from './archive-store'

const MAGIC = 'KBMAP001'
const PREFIX_BYTES = 12
const MAX_HEADER_BYTES = 256 * 1024
const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024
const MAX_FILES = 1024
const exactPaths = new Set([
  'basemap.pmtiles', 'README.md',
  'sprites/light.json', 'sprites/light.png', 'sprites/light@2x.json', 'sprites/light@2x.png',
  'licenses/Noto-OFL.txt', 'licenses/protomaps-BSD-3-Clause.txt',
  'licenses/basemaps-assets-README.md', 'licenses/tangrams-icons-MIT.txt',
])

type Entry = { offset: number; length: number }
type Options = { spec: CityArchiveSpec; blob?: Blob; fetcher?: typeof fetch; origin?: string }
type RangeFlight = { promise: Promise<ArrayBuffer>; controller: AbortController; users: number }

function abortError() { return new DOMException('Загрузка карты отменена', 'AbortError') }
function throwIfAborted(signal?: AbortSignal) { if (signal?.aborted) throw abortError() }
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function validPath(path: string) {
  if (exactPaths.has(path)) return true
  const glyph = /^fonts\/Noto Sans (?:Regular|Medium|Italic)\/(\d+)-(\d+)\.pbf$/.exec(path)
  if (!glyph) return false
  const start = Number(glyph[1]), end = Number(glyph[2])
  return start >= 0 && start % 256 === 0 && end === start + 255 && end <= 65535
    && glyph[1] === String(start) && glyph[2] === String(end)
}

/** Each caller can cancel without cancelling another consumer of a shared read. */
function consume<T>(promise: Promise<T>, signal?: AbortSignal, release?: (aborted: boolean) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (aborted: boolean, action: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      release?.(aborted)
      action()
    }
    const onAbort = () => finish(true, () => reject(abortError()))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(value => finish(false, () => resolve(value)), error => finish(false, () => reject(error)))
  })
}

async function exactBody(response: Response, bytes: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== bytes)) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Размер ответа карты не совпадает.')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Пустой ответ карты.')
  const result = new Uint8Array(bytes)
  let received = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      throwIfAborted(signal)
      const { done, value } = await reader.read()
      if (done) break
      if (received + value.byteLength > bytes) throw new Error('Ответ карты превышает ожидаемый размер.')
      result.set(value, received)
      received += value.byteLength
    }
    throwIfAborted(signal)
    if (received !== bytes) throw new Error('Карта загрузилась не полностью.')
    return result.buffer
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/** Reads immutable, same-origin city assets without unpacking hundreds of files. */
export class CityMapBundle {
  readonly spec: CityArchiveSpec
  private readonly url: string
  private readonly fetcher: typeof fetch
  private blob?: Blob
  private files = new Map<string, Entry>()
  private payloadOffset = 0
  private initialization?: Promise<this>
  private fullBlobFlight?: Promise<Blob>
  private readonly ranges = new Map<string, RangeFlight>()

  constructor(options: Options) {
    const { spec } = options
    if (!spec.version || !Number.isSafeInteger(spec.bytes) || spec.bytes < PREFIX_BYTES + 1
      || spec.bytes > MAX_ARCHIVE_BYTES || !/^[a-f0-9]{64}$/i.test(spec.sha256)) {
      throw new Error('Неверное описание файла карты.')
    }
    const origin = options.origin ?? (typeof location === 'undefined' ? 'https://localhost' : location.origin)
    const url = new URL(spec.url, origin)
    if (url.origin !== origin || !/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) {
      throw new Error('Неверный адрес файла карты.')
    }
    this.spec = { ...spec }
    this.url = url.href
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
    if (options.blob) this.setBlob(options.blob)
  }

  /** Cached blobs have already passed the archive store's SHA-256 validation. */
  setBlob(blob: Blob): void {
    if (blob.size !== this.spec.bytes) throw new Error('Размер сохранённой карты не совпадает.')
    this.blob = blob
  }

  initialize(signal?: AbortSignal): Promise<this> {
    throwIfAborted(signal)
    // The small shared index remains useful when a map consumer is cancelled.
    this.initialization ??= this.readHeader().then(() => this).catch(error => {
      this.initialization = undefined
      throw error
    })
    return consume(this.initialization, signal)
  }

  hasFile(path: string): boolean { return this.files.has(path) }

  async readFile(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    await this.initialize(signal)
    const entry = this.entry(path)
    return this.readAbsolute(this.payloadOffset + entry.offset, entry.length, signal)
  }

  async readRange(path: string, offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    await this.initialize(signal)
    const entry = this.entry(path)
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > entry.length) {
      throw new Error('Неверный диапазон файла карты.')
    }
    // PMTiles initially requests up to 16 KiB, even for a smaller embedded file.
    return this.readAbsolute(this.payloadOffset + entry.offset + offset, Math.min(length, entry.length - offset), signal)
  }

  private entry(path: string): Entry {
    const entry = this.files.get(path)
    if (!entry) throw new Error('Ресурс отсутствует в карте.')
    return entry
  }

  private async readHeader() {
    const prefix = await this.readAbsolute(0, PREFIX_BYTES)
    if (new TextDecoder().decode(prefix.slice(0, 8)) !== MAGIC) throw new Error('Неверный формат карты.')
    const length = new DataView(prefix).getUint32(8, true)
    if (length === 0 || length > MAX_HEADER_BYTES || PREFIX_BYTES + length >= this.spec.bytes) {
      throw new Error('Неверный размер заголовка карты.')
    }
    const header: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(await this.readAbsolute(PREFIX_BYTES, length)))
    if (!object(header) || header.version !== 1 || !object(header.files)) throw new Error('Неверный заголовок карты.')
    const entries = Object.entries(header.files)
    if (!entries.length || entries.length > MAX_FILES) throw new Error('Неверный список ресурсов карты.')
    const payloadOffset = PREFIX_BYTES + length
    const payloadBytes = this.spec.bytes - payloadOffset
    const files = new Map<string, Entry>()
    for (const [path, value] of entries) {
      if (!validPath(path) || !object(value) || typeof value.offset !== 'number' || typeof value.length !== 'number'
        || !Number.isSafeInteger(value.offset) || !Number.isSafeInteger(value.length)
        || value.offset < 0 || value.length <= 0 || value.offset > payloadBytes - value.length) {
        throw new Error('Неверный ресурс карты.')
      }
      files.set(path, { offset: value.offset, length: value.length })
    }
    const sorted = [...files.values()].sort((a, b) => a.offset - b.offset)
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index]!.offset < sorted[index - 1]!.offset + sorted[index - 1]!.length) {
        throw new Error('Ресурсы карты пересекаются.')
      }
    }
    if ((files.get('basemap.pmtiles')?.length ?? 0) < 127) throw new Error('В архиве отсутствует карта.')
    this.files = files
    this.payloadOffset = payloadOffset
  }

  private async readAbsolute(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    throwIfAborted(signal)
    if (!length) return new ArrayBuffer(0)
    if (this.blob) return consume(this.blob.slice(offset, offset + length).arrayBuffer(), signal)
    if (this.fullBlobFlight) {
      const blob = await consume(this.fullBlobFlight, signal)
      return consume(blob.slice(offset, offset + length).arrayBuffer(), signal)
    }
    const key = `${offset}:${length}`
    let flight = this.ranges.get(key)
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController()
      const promise = this.fetchRange(offset, length, controller.signal).finally(() => {
        if (this.ranges.get(key)?.controller === controller) this.ranges.delete(key)
      })
      flight = { promise, controller, users: 0 }
      this.ranges.set(key, flight)
    }
    const selected = flight
    selected.users++
    return consume(selected.promise, signal, aborted => {
      selected.users--
      // A full-response fallback is shared by all ranges and must finish once.
      if (aborted && !selected.users && !this.fullBlobFlight) selected.controller.abort()
    })
  }

  private async fetchRange(offset: number, length: number, signal: AbortSignal): Promise<ArrayBuffer> {
    const response = await this.fetcher(this.url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
    })
    if (response.url && new URL(response.url).origin !== new URL(this.url).origin) {
      await response.body?.cancel().catch(() => {})
      throw new Error('Неверный адрес ответа карты.')
    }
    if (this.blob) {
      await response.body?.cancel().catch(() => {})
      return this.blob.slice(offset, offset + length).arrayBuffer()
    }
    if (response.status === 200) {
      if (!this.fullBlobFlight) {
        this.fullBlobFlight = this.verifyFullResponse(response, signal).catch(error => {
          this.fullBlobFlight = undefined
          throw error
        })
      } else await response.body?.cancel().catch(() => {})
      const blob = await this.fullBlobFlight
      return blob.slice(offset, offset + length).arrayBuffer()
    }
    const expected = `bytes ${offset}-${offset + length - 1}/${this.spec.bytes}`
    if (response.status !== 206 || response.headers.get('content-range') !== expected) {
      await response.body?.cancel().catch(() => {})
      throw new Error('Сервер вернул неверный диапазон карты.')
    }
    return exactBody(response, length, signal)
  }

  private async verifyFullResponse(response: Response, signal: AbortSignal): Promise<Blob> {
    const data = await exactBody(response, this.spec.bytes, signal)
    const digest = await crypto.subtle.digest('SHA-256', data)
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    if (hash !== this.spec.sha256.toLowerCase()) throw new Error('Файл карты повреждён.')
    const blob = new Blob([data])
    this.blob = blob
    return blob
  }
}
