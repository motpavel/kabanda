import { afterEach, expect, it, vi } from 'vitest'
import { startFinalizationWorker } from '../src/finalization-worker.js'

afterEach(() => vi.useRealTimers())

it('recovers on startup and retries after errors without overlapping; shutdown drains work', async () => {
  vi.useFakeTimers()
  let release!: () => void
  const sweep = vi.fn()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
  const onError = vi.fn()
  const stop = startFinalizationWorker(sweep, onError)
  await vi.advanceTimersByTimeAsync(0)
  expect(sweep).toHaveBeenCalledTimes(1)
  expect(onError).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(sweep).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(sweep).toHaveBeenCalledTimes(2)
  let drained = false
  const stopped = stop().then(() => { drained = true })
  await Promise.resolve()
  expect(drained).toBe(false)
  release()
  await stopped
  await vi.advanceTimersByTimeAsync(60_000)
  expect(sweep).toHaveBeenCalledTimes(2)
})
