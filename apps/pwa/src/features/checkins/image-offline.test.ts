import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeImageSource } from './image-source'

let mode: 'load' | 'error' | 'hang'
let result = 'data:image/png;base64,cGl4ZWxz'
const abort = vi.fn(), read = vi.fn()
class Reader {
  result: string | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  readAsDataURL(file: Blob) {
    read(file)
    if (mode === 'hang') return
    this.result = result
    queueMicrotask(() => mode === 'load' ? this.onload?.() : this.onerror?.())
  }
  abort() { abort(); this.onabort?.() }
}
class NativeImage {
  naturalWidth = 640
  naturalHeight = 480
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  decoding = ''
  private value = ''
  get src() { return this.value }
  set src(value: string) {
    this.value = value
    if (value) queueMicrotask(() => value.startsWith('blob:') ? this.onerror?.() : this.onload?.())
  }
}
beforeEach(() => {
  mode = 'load'; result = 'data:image/png;base64,cGl4ZWxz'; abort.mockClear(); read.mockClear()
  vi.stubGlobal('Image', NativeImage); vi.stubGlobal('FileReader', Reader)
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new TypeError('Local blob loader unavailable')))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:offline-photo')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('offline local-bytes decoder fallback', () => {
  it('reads the same selected bytes locally when both bitmap and blob URL fail', async () => {
    const file = new File(['pixels'], 'photo.png', { type: 'image/png' })
    const image = await decodeImageSource(file)
    expect(image).toMatchObject({ width: 640, height: 480 })
    expect(read).toHaveBeenCalledWith(file)
    expect((image.source as unknown as NativeImage).src).toBe(result)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:offline-photo')
    expect(await file.text()).toBe('pixels')
    image.release(); image.release()
    expect((image.source as unknown as NativeImage).src).toBe('')
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })
  it('does not report success for an unreadable file', async () => {
    mode = 'error'
    await expect(decodeImageSource(new Blob(['pixels'], { type: 'image/png' }))).rejects.toThrow('file unavailable')
  })
  it('bounds and aborts a stalled local read', async () => {
    vi.useFakeTimers(); mode = 'hang'
    const pending = expect(decodeImageSource(new Blob(['pixels'], { type: 'image/png' }))).rejects.toThrow('read timed out')
    await vi.advanceTimersByTimeAsync(10001); await pending
    expect(abort).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })
  it('rejects an unexpected data URL rather than decoding remote or active content', async () => {
    result = 'data:image/svg+xml;base64,PHN2Zz4='
    await expect(decodeImageSource(new Blob(['pixels'], { type: 'image/png' }))).rejects.toThrow('Invalid image source')
  })
  it('does not duplicate an oversized file into a base64 string', async () => {
    const file = new Blob([new Uint8Array(32 * 1024 * 1024 + 1)], { type: 'image/png' })
    await expect(decodeImageSource(file)).rejects.toThrow('source too large')
    expect(read).not.toHaveBeenCalled()
  })
})
