import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPhotoUploadBody } from './upload-body'
import { uploadMediaContent } from './api'

const original = new Uint8Array([0, 255, 128, 31, 0, 16, 243, 17])
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('saved binary upload', () => {
  it('materializes exact bytes without modifying the persisted blob', async () => {
    const blob = new Blob([original], { type: 'image/jpeg' })
    const bytes = await readPhotoUploadBody(blob)
    expect([...new Uint8Array(bytes)]).toEqual([...original])
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(original)
    expect(blob.type).toBe('image/jpeg')
  })
  it('rejects empty and oversized inputs before any read', async () => {
    for (const size of [0, -1, 8 * 1024 * 1024 + 1]) {
      const arrayBuffer = vi.fn()
      await expect(readPhotoUploadBody({ size, arrayBuffer } as unknown as Blob)).rejects.toThrow('size is invalid')
      expect(arrayBuffer).not.toHaveBeenCalled()
    }
  })
  it('does not submit truncated bytes as a successful upload', async () => {
    const blob = new Blob([original])
    vi.spyOn(blob, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(0))
    await expect(readPhotoUploadBody(blob)).rejects.toThrow('incomplete')
  })
  it('bounds a stalled local read without cancelling or clearing saved work', async () => {
    vi.useFakeTimers()
    const blob = new Blob([original])
    vi.spyOn(blob, 'arrayBuffer').mockImplementation(() => new Promise<ArrayBuffer>(() => {}))
    const failed = expect(readPhotoUploadBody(blob)).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await failed
    expect(vi.getTimerCount()).toBe(0)
  })
  it('propagates local failures without making any network request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const blob = new Blob([original], { type: 'image/jpeg' })
    vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new TypeError('Unavailable'))
    await expect(uploadMediaContent('raid', 'intent', 'synthetic-capability', 'a'.repeat(64), blob)).rejects.toThrow('Unavailable')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('passes owned binary bytes and unchanged MIME/hash/capability to transport', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ media: { id: 'media' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const blob = new Blob([original], { type: 'image/jpeg' })
    await uploadMediaContent('raid', 'intent', 'synthetic-capability', 'a'.repeat(64), blob)
    const [path, init] = fetch.mock.calls[0]!
    expect(path).toBe('/api/raids/raid/media/intents/intent/content')
    expect(init.body).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(init.body)).toEqual(original)
    expect(init.headers).toMatchObject({ 'Content-Type': 'image/jpeg', 'X-Content-SHA256': 'a'.repeat(64), 'X-Upload-Capability': 'synthetic-capability' })
  })
})
