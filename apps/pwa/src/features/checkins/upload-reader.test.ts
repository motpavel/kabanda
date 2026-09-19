import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPhotoUploadBody } from './upload-body'

const bytes = new Uint8Array([255, 0, 128, 17])
const readers: Reader[] = []
let mode: 'ok' | 'error' | 'throw' | 'stall' | 'empty' = 'ok'
class Reader {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  result: ArrayBuffer | null = null
  error: DOMException | null = null
  readyState = 0
  abort = vi.fn(() => { this.readyState = 2; this.onabort?.() })
  constructor() { readers.push(this) }
  readAsArrayBuffer(_blob: Blob) {
    if (mode === 'throw') throw new DOMException('Unavailable', 'NotFoundError')
    this.readyState = 1
    if (mode === 'stall') return
    queueMicrotask(() => {
      this.readyState = 2
      if (mode === 'error') { this.error = new DOMException('Unavailable', 'NotReadableError'); this.onerror?.(); return }
      this.result = mode === 'empty' ? new ArrayBuffer(0) : bytes.slice().buffer
      this.onload?.()
    })
  }
}
function failedBlob(name = 'NotFoundError') {
  const blob = new Blob([bytes], { type: 'image/jpeg' })
  vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new DOMException('Native unavailable', name))
  return blob
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); readers.length = 0; mode = 'ok' })

describe('local saved-Blob reader fallback', () => {
  it.each(['NotFoundError', 'NotReadableError'])('recovers %s through native FileReader without reencoding', async name => {
    vi.stubGlobal('FileReader', Reader)
    expect(new Uint8Array(await readPhotoUploadBody(failedBlob(name)))).toEqual(bytes)
    expect(readers).toHaveLength(1)
    expect(readers[0]).toMatchObject({ onload: null, onerror: null, onabort: null })
  })
  it('does not attempt another access path after a security denial', async () => {
    vi.stubGlobal('FileReader', Reader)
    await expect(readPhotoUploadBody(failedBlob('SecurityError'))).rejects.toMatchObject({ name: 'SecurityError' })
    expect(readers).toHaveLength(0)
  })
  it.each(['error', 'throw', 'empty'] as const)('retains a failed read for normal queue retry: %s', async next => {
    mode = next; vi.stubGlobal('FileReader', Reader)
    await expect(readPhotoUploadBody(failedBlob())).rejects.toThrow()
    expect(readers[0]).toMatchObject({ onload: null, onerror: null, onabort: null })
  })
  it('aborts only the local reader at the shared deadline, retaining the original blob', async () => {
    mode = 'stall'; vi.useFakeTimers(); vi.stubGlobal('FileReader', Reader)
    const blob = failedBlob()
    const assertion = expect(readPhotoUploadBody(blob)).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10_000); await assertion
    expect(readers[0]!.abort).toHaveBeenCalledTimes(1)
    expect(blob.size).toBe(bytes.length)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not create a new reader when the original promise rejects after timeout', async () => {
    vi.useFakeTimers(); vi.stubGlobal('FileReader', Reader)
    const blob = new Blob([bytes]); let fail!: (reason: unknown) => void
    vi.spyOn(blob, 'arrayBuffer').mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    const assertion = expect(readPhotoUploadBody(blob)).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10_000); await assertion
    fail(new DOMException('Late file failure', 'NotFoundError'))
    await vi.advanceTimersByTimeAsync(1)
    expect(readers).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
