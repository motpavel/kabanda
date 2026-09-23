/// <reference types="node" />
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { PMTiles } from 'pmtiles'
import type { CityArchiveSpec } from './archive-store'
import { CityMapBundle } from './bundle'
import { IZHEVSK_ARCHIVE } from './manifest'

const glyphPath = 'fonts/Noto Sans Regular/1024-1279.pbf'
const glyph = new Uint8Array([11, 22, 33, 44, 55, 66])
const baseFiles = {
  'basemap.pmtiles': { offset: 0, length: 256 },
  [glyphPath]: { offset: 256, length: glyph.length },
}
const decoder = new TextDecoder()

async function fixture(header: unknown = { version: 1, files: baseFiles }, patch?: (bytes: Uint8Array) => void) {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  const prefix = new Uint8Array(12)
  prefix.set(new TextEncoder().encode('KBMAP001'))
  new DataView(prefix.buffer).setUint32(8, headerBytes.length, true)
  const payload = new Uint8Array(256 + glyph.length)
  payload.set(new TextEncoder().encode('PMTiles\x03'))
  payload.set(glyph, 256)
  const blob = new Blob([prefix, headerBytes, payload])
  const bytes = new Uint8Array(await blob.arrayBuffer())
  patch?.(bytes)
  const finalBlob = new Blob([bytes])
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const spec: CityArchiveSpec = {
    version: 'test-city', url: '/assets/izhevsk-test.kmap', bytes: bytes.length,
    sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
  }
  return { blob: finalBlob, spec, payloadOffset: 12 + headerBytes.length }
}

function rangeFetcher(blob: Blob) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') ?? '')!
    const start = Number(range[1]), end = Number(range[2])
    return new Response(await blob.slice(start, end + 1).arrayBuffer(), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${blob.size}`, 'Content-Length': String(end - start + 1) },
    })
  })
}

describe('city map bundle', () => {
  it('reads cached assets offline without making any network requests', async () => {
    const { spec, blob } = await fixture()
    const fetcher = vi.fn()
    const bundle = new CityMapBundle({ spec, blob, fetcher })
    expect(await bundle.initialize()).toBe(bundle)
    expect(bundle.hasFile(glyphPath)).toBe(true)
    expect(bundle.hasFile('absent.png')).toBe(false)
    expect(new Uint8Array(await bundle.readFile(glyphPath))).toEqual(glyph)
    expect(decoder.decode(await bundle.readRange('basemap.pmtiles', 0, 7))).toBe('PMTiles')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('loads only the index and requested embedded file from same-origin byte ranges', async () => {
    const { spec, blob, payloadOffset } = await fixture()
    const fetcher = rangeFetcher(blob)
    const bundle = new CityMapBundle({ spec, fetcher })
    expect(new Uint8Array(await bundle.readFile(glyphPath))).toEqual(glyph)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('Range'))).toEqual([
      'bytes=0-11', `bytes=12-${payloadOffset - 1}`, `bytes=${payloadOffset + 256}-${blob.size - 1}`,
    ])
    expect(fetcher).toHaveBeenCalledWith('https://localhost/assets/izhevsk-test.kmap', expect.objectContaining({
      credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    }))
  })

  it('deduplicates the index and simultaneous reads of the same resource', async () => {
    const { spec, blob } = await fixture()
    const fetcher = rangeFetcher(blob)
    const bundle = new CityMapBundle({ spec, fetcher })
    const results = await Promise.all([bundle.readFile(glyphPath), bundle.readFile(glyphPath), bundle.initialize()])
    expect(new Uint8Array(results[0] as ArrayBuffer)).toEqual(glyph)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('switches all subsequent reads to the verified cache blob', async () => {
    const { spec, blob } = await fixture()
    const fetcher = rangeFetcher(blob)
    const bundle = new CityMapBundle({ spec, fetcher })
    await bundle.initialize()
    expect(fetcher).toHaveBeenCalledTimes(2)
    bundle.setBlob(blob)
    await bundle.readFile(glyphPath)
    await bundle.readRange('basemap.pmtiles', 100, 20)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(() => bundle.setBlob(new Blob(['incomplete']))).toThrow('Размер')
  })

  it('clamps PMTiles probe reads at the embedded file boundary and never reads the next file', async () => {
    const { spec, blob } = await fixture()
    const bundle = new CityMapBundle({ spec, blob })
    expect((await bundle.readRange('basemap.pmtiles', 0, 16384)).byteLength).toBe(256)
    expect((await bundle.readRange('basemap.pmtiles', 256, 16384)).byteLength).toBe(0)
    expect(new Uint8Array(await bundle.readRange(glyphPath, 3, 100))).toEqual(glyph.slice(3))
    for (const [offset, length] of [[257, 1], [-1, 1], [.5, 1], [0, -1], [0, Infinity]]) {
      await expect(bundle.readRange('basemap.pmtiles', offset!, length!)).rejects.toThrow('диапазон')
    }
    await expect(bundle.readFile('../outside')).rejects.toThrow('отсутствует')
  })

  it('uses a complete HTTP 200 response only once and verifies its digest', async () => {
    const { spec, blob } = await fixture()
    const fetcher = vi.fn(async () => new Response(blob))
    const bundle = new CityMapBundle({ spec, fetcher })
    const results = await Promise.all([bundle.readFile(glyphPath), bundle.readRange('basemap.pmtiles', 0, 8)])
    expect(new Uint8Array(results[0]!)).toEqual(glyph)
    expect(decoder.decode(results[1])).toBe('PMTiles\x03')
    await bundle.readFile(glyphPath)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects a complete HTTP 200 archive with a wrong digest', async () => {
    const { spec, blob } = await fixture()
    const bundle = new CityMapBundle({ spec: { ...spec, sha256: '0'.repeat(64) }, fetcher: vi.fn(async () => new Response(blob)) })
    await expect(bundle.initialize()).rejects.toThrow('повреждён')
    expect(bundle.hasFile('basemap.pmtiles')).toBe(false)
  })

  it.each([
    ['wrong start', 'bytes 1-12/TOTAL'],
    ['wrong end', 'bytes 0-10/TOTAL'],
    ['wrong total', 'bytes 0-11/999999'],
    ['missing header', null],
  ])('rejects a partial HTTP response with %s', async (_label, contentRange) => {
    const { spec, blob } = await fixture()
    const headers: Record<string, string> = contentRange ? { 'Content-Range': contentRange.replace('TOTAL', String(blob.size)) } : {}
    const fetcher = vi.fn(async () => new Response(await blob.slice(0, 12).arrayBuffer(), { status: 206, headers }))
    await expect(new CityMapBundle({ spec, fetcher }).initialize()).rejects.toThrow('диапазон')
  })

  it.each([11, 13])('rejects a range body with %i bytes instead of the requested twelve', async size => {
    const { spec, blob } = await fixture()
    const fetcher = vi.fn(async () => new Response(await blob.slice(0, size).arrayBuffer(), {
      status: 206, headers: { 'Content-Range': `bytes 0-11/${blob.size}` },
    }))
    await expect(new CityMapBundle({ spec, fetcher }).initialize()).rejects.toThrow()
  })

  it('bounds full-response fallback streams and rejects truncated downloads', async () => {
    const { spec, blob } = await fixture()
    for (const body of [blob.slice(0, blob.size - 1), new Blob([blob, 'extra'])]) {
      const bundle = new CityMapBundle({ spec, fetcher: vi.fn(async () => new Response(body)) })
      await expect(bundle.initialize()).rejects.toThrow()
    }
  })

  it.each([
    ['unknown version', { version: 2, files: baseFiles }],
    ['absent map', { version: 1, files: { [glyphPath]: { offset: 256, length: 6 } } }],
    ['traversal', { version: 1, files: { ...baseFiles, '../secret': { offset: 0, length: 2 } } }],
    ['encoded traversal', { version: 1, files: { ...baseFiles, 'fonts/%2e%2e/x': { offset: 0, length: 2 } } }],
    ['unrecognised glyph block', { version: 1, files: { ...baseFiles, 'fonts/Noto Sans Regular/1-256.pbf': { offset: 0, length: 2 } } }],
    ['out of bounds', { version: 1, files: { ...baseFiles, [glyphPath]: { offset: 256, length: 7 } } }],
    ['negative offset', { version: 1, files: { ...baseFiles, [glyphPath]: { offset: -1, length: 6 } } }],
    ['fractional offset', { version: 1, files: { ...baseFiles, [glyphPath]: { offset: .5, length: 6 } } }],
    ['unsafe length', { version: 1, files: { ...baseFiles, [glyphPath]: { offset: 256, length: Number.MAX_SAFE_INTEGER + 1 } } }],
    ['overlapping files', { version: 1, files: { ...baseFiles, [glyphPath]: { offset: 255, length: 6 } } }],
  ])('rejects an archive index with %s before exposing files', async (_label, header) => {
    const { spec, blob } = await fixture(header)
    const bundle = new CityMapBundle({ spec, blob })
    await expect(bundle.initialize()).rejects.toThrow()
    expect(bundle.hasFile('basemap.pmtiles')).toBe(false)
  })

  it('rejects incorrect magic and oversized headers before requesting their payload', async () => {
    for (const patch of [
      (bytes: Uint8Array) => { bytes[0] = 0 },
      (bytes: Uint8Array) => new DataView(bytes.buffer).setUint32(8, 256 * 1024 + 1, true),
    ]) {
      const { spec, blob } = await fixture(undefined, patch)
      const fetcher = rangeFetcher(blob)
      await expect(new CityMapBundle({ spec, fetcher }).initialize()).rejects.toThrow()
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it('rejects non-same-origin URLs and embedded credentials before any request', async () => {
    const { spec } = await fixture()
    for (const url of ['https://elsewhere.example/city.kmap', '//elsewhere.example/city.kmap', 'data:application/octet-stream,x', 'https://name:pass@localhost/city.kmap']) {
      expect(() => new CityMapBundle({ spec: { ...spec, url } })).toThrow('адрес')
    }
  })

  it('does not let a cancelled reader cancel another consumer of the same range', async () => {
    const { spec, blob } = await fixture()
    const normalFetch = rangeFetcher(blob)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (normalFetch.mock.calls.length === 2) await pending
      return normalFetch(url, init)
    })
    const bundle = new CityMapBundle({ spec, fetcher })
    await bundle.initialize()
    const controller = new AbortController()
    const cancelled = bundle.readFile(glyphPath, controller.signal)
    const kept = bundle.readFile(glyphPath)
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
    controller.abort()
    release()
    await rejected
    expect(new Uint8Array(await kept)).toEqual(glyph)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('aborts an unshared range request and permits a later retry', async () => {
    const { spec, blob } = await fixture()
    const normalFetch = rangeFetcher(blob)
    let requestSignal: AbortSignal | undefined
    let cancelNextRange = true
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (normalFetch.mock.calls.length === 2 && cancelNextRange) {
        cancelNextRange = false
        requestSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
        })
      }
      return normalFetch(url, init)
    })
    const bundle = new CityMapBundle({ spec, fetcher })
    await bundle.initialize()
    const controller = new AbortController()
    const result = bundle.readFile(glyphPath, controller.signal)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    controller.abort()
    await rejected
    expect(requestSignal?.aborted).toBe(true)
    expect(new Uint8Array(await bundle.readFile(glyphPath))).toEqual(glyph)
  })

  it('opens real city tiles at all native zooms plus every font/sprite without a network request', async () => {
    const bytes = await readFile(new URL('./assets/izhevsk-20260923.kmap', import.meta.url))
    const blob = new Blob([new Uint8Array(bytes)])
    expect(blob.size).toBe(IZHEVSK_ARCHIVE.bytes)
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    expect(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')).toBe(IZHEVSK_ARCHIVE.sha256)
    const fetcher = vi.fn(async () => { throw new Error('This map must be independent of the network') })
    const bundle = await new CityMapBundle({ spec: IZHEVSK_ARCHIVE, blob, fetcher }).initialize()
    const tiles = new PMTiles({
      getKey: () => 'offline-test-city',
      getBytes: async (offset, length, signal) => ({ data: await bundle.readRange('basemap.pmtiles', offset, length, signal) }),
    })
    const header = await tiles.getHeader()
    expect(header).toMatchObject({ minZoom: 0, maxZoom: 15, minLon: 53, minLat: 56.7, maxLon: 53.4, maxLat: 57 })
    const latitude = 56.8526 * Math.PI / 180
    for (let zoom = 0; zoom <= 15; zoom++) {
      const width = 2 ** zoom
      const x = Math.floor((53.2045 + 180) / 360 * width)
      const y = Math.floor((1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2 * width)
      const tile = await tiles.getZxy(zoom, x, y)
      expect(tile?.data.byteLength, `city tile ${zoom}/${x}/${y}`).toBeGreaterThan(0)
      // A decoded MVT starts with protobuf field 3 (layers), wire type 2.
      expect(new Uint8Array(tile!.data)[0]).toBe(0x1a)
    }
    for (const font of ['Regular', 'Medium', 'Italic']) {
      for (let start = 0; start < 65536; start += 256) {
        const glyph = new Uint8Array(await bundle.readFile(`fonts/Noto Sans ${font}/${start}-${start + 255}.pbf`))
        // A MapLibre glyph PBF starts with protobuf field 1 (font stacks).
        expect(glyph[0]).toBe(0x0a)
      }
    }
    expect(decoder.decode(await bundle.readRange('basemap.pmtiles', 0, 8))).toBe('PMTiles\x03')
    for (const suffix of ['', '@2x']) {
      const sprite = JSON.parse(decoder.decode(await bundle.readFile(`sprites/light${suffix}.json`)))
      expect(Object.keys(sprite).length).toBeGreaterThan(1)
      const png = new Uint8Array(await bundle.readFile(`sprites/light${suffix}.png`))
      expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    }
    expect(decoder.decode(await bundle.readFile('licenses/Noto-OFL.txt'))).toContain('SIL OPEN FONT LICENSE')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
