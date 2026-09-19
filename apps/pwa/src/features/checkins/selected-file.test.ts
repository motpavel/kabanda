import { describe, expect, it, vi } from 'vitest'
import { consumeSelectedFile } from './selected-file'
function inputWith(file?: File) {
  return { files: (file ? [file] : []) as unknown as FileList, value: file ? 'selected-photo' : '' }
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
describe('selected photo lifetime', () => {
  it('does not clear the input while asynchronous file reading is pending', async () => {
    const file = new File(['photo'], 'photo.png', { type: 'image/png' }), input = inputWith(file)
    const gate = deferred(), consume = vi.fn(() => gate.promise)
    const work = consumeSelectedFile(input, consume)
    expect(consume).toHaveBeenCalledWith(file)
    expect(input.value).toBe('selected-photo')
    await Promise.resolve()
    expect(input.value).toBe('selected-photo')
    gate.resolve(); await work
    expect(input.value).toBe('')
    expect(await file.text()).toBe('photo')
  })
  it('resets after failure as well, permitting another choice of the same file', async () => {
    const input = inputWith(new File(['photo'], 'photo.png')), gate = deferred()
    const work = consumeSelectedFile(input, () => gate.promise)
    const check = expect(work).rejects.toThrow('decode failed')
    gate.reject(new Error('decode failed')); await check
    expect(input.value).toBe('')
  })
  it('never clears a newer choice after an older read completes', async () => {
    const input = inputWith(new File(['old'], 'old.png')), gate = deferred()
    const work = consumeSelectedFile(input, () => gate.promise)
    input.files = [new File(['new'], 'new.png')] as unknown as FileList
    input.value = 'new-selection'
    gate.resolve(); await work
    expect(input.value).toBe('new-selection')
  })
  it('does nothing for a cancelled file picker', async () => {
    const input = inputWith(), consume = vi.fn(async () => {})
    await consumeSelectedFile(input, consume)
    expect(consume).not.toHaveBeenCalled()
  })
})
