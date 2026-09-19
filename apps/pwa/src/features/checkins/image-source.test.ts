import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeImageSource } from './image-source'
import { prepareMediaFile } from './platform'

let outcome: 'load' | 'error' | 'hang'
let dimensions: [number, number]
class NativeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = dimensions[0]
  naturalHeight = dimensions[1]
  decoding = ''
  private value = ''
  get src() { return this.value }
  set src(value: string) {
    this.value = value
    if (value && outcome !== 'hang') queueMicrotask(() => outcome === 'load' ? this.onload?.() : this.onerror?.())
  }
}
const file = () => new File(['synthetic file'], 'photo.png', { type: 'image/png' })
beforeEach(() => {
  outcome = 'load'; dimensions = [8064, 6048]
  vi.stubGlobal('Image', NativeImage)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-image')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('cross-engine image preparation', () => {
  it('uses the optimized bitmap when supported and closes it afterwards', async () => {
    const bitmap = { width: 2048, height: 1536, close: vi.fn() }
    const decode = vi.fn().mockResolvedValue(bitmap); vi.stubGlobal('createImageBitmap', decode)
    const selected = file(), image = await decodeImageSource(selected)
    expect(decode).toHaveBeenCalledWith(selected, expect.objectContaining({ resizeWidth: 2048, imageOrientation: 'from-image' }))
    expect(image.source).toBe(bitmap)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    image.release(); expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('falls back to native decoding when ImageBitmap rejects a valid file', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new TypeError('Unsupported resize option')))
    const selected = file(), image = await decodeImageSource(selected)
    expect(image.source).toBeInstanceOf(NativeImage)
    expect(image).toMatchObject({ width: 8064, height: 6048 })
    expect(URL.createObjectURL).toHaveBeenCalledWith(selected)
    image.release(); image.release()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect((image.source as unknown as NativeImage).src).toBe('')
  })

  it('works without ImageBitmap and still revokes temporary image URLs', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    const image = await decodeImageSource(file())
    image.release()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-image')
  })

  it('cleans up a malformed image rejected by both decoders', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')))
    outcome = 'error'
    await expect(decodeImageSource(file())).rejects.toThrow('Invalid image')
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('does not keep a failed native decoder or its URL alive indefinitely', async () => {
    vi.useFakeTimers(); outcome = 'hang'; vi.stubGlobal('createImageBitmap', undefined)
    const pending = expect(decodeImageSource(file())).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10000); await pending
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('uses the same capped JPEG canvas after fallback and releases all temporary resources', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('resize failed')))
    const output = new Blob(['encoded jpeg'], { type: 'image/jpeg' })
    const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }
    const canvas = { width: 0, height: 0, getContext: () => context,
      toBlob: vi.fn((callback: (blob: Blob) => void) => callback(output)) }
    vi.stubGlobal('document', { createElement: () => canvas })
    const selected = file(), before = await selected.text()
    expect(await prepareMediaFile(selected)).toBe(output)
    expect(context.drawImage).toHaveBeenCalledWith(expect.any(NativeImage), 0, 0, 2048, 1536)
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', .82)
    expect(canvas.width).toBe(1); expect(canvas.height).toBe(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(await selected.text()).toBe(before)
  })
})
