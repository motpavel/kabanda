import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { experimentDb, LIMIT_MS, type ExperimentRun } from './experiment-data'
import { createExperimentRecorder } from './experiment-runtime'

class TestDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
}

class TestWorker extends EventTarget {
  static instances: TestWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() {
    super()
    TestWorker.instances.push(this)
  }
}

describe('GPS experiment runtime with audio', () => {
  let page: TestDocument
  let run: ExperimentRun
  let recorder: ReturnType<typeof createExperimentRecorder> | undefined
  let gpsFailure: PositionErrorCallback
  const watchPosition = vi.fn((_success: PositionCallback, failure: PositionErrorCallback) => {
    gpsFailure = failure
    return 77
  })
  const getCurrentPosition = vi.fn()
  const clearWatch = vi.fn()
  const onStop = vi.fn()
  const onError = vi.fn()

  beforeEach(async () => {
    vi.clearAllMocks()
    // Leave IndexedDB's asynchronous task scheduling real while controlling
    // only recorder clocks and intervals.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(1_000_000)
    page = new TestDocument()
    TestWorker.instances = []
    vi.stubGlobal('document', page)
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('navigator', { geolocation: { watchPosition, getCurrentPosition, clearWatch } })
    vi.stubGlobal('Worker', TestWorker)
    vi.stubGlobal('performance', { timeOrigin: 1_000_000, now: () => Date.now() - 1_000_000 })
    run = {
      id: crypto.randomUUID(), startedAt: Date.now(), mode: 'audio', keepScreen: false,
      displayMode: 'standalone', userAgent: 'test', version: 'test', persisted: null,
    }
    await experimentDb.open()
    await experimentDb.runs.add(run)
    recorder = createExperimentRecorder(run, vi.fn(), onError, onStop)
  })

  afterEach(async () => {
    await recorder?.stop()
    recorder = undefined
    await experimentDb.delete()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts only a GPS watch and tears down audio, worker and timers once on stop', async () => {
    recorder!.start()
    vi.advanceTimersByTime(25_000)
    expect(watchPosition).toHaveBeenCalledExactlyOnceWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: true, maximumAge: 0, timeout: 12_000,
    })
    expect(getCurrentPosition).not.toHaveBeenCalled()
    expect(TestWorker.instances[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id, limitMs: LIMIT_MS }))

    const firstStop = recorder!.stop()
    const secondStop = recorder!.stop()
    expect(secondStop).toBe(firstStop)
    await firstStop

    expect(onStop).toHaveBeenCalledTimes(1)
    expect(clearWatch).toHaveBeenCalledExactlyOnceWith(77)
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(recorder!.active).toBe(false)
    const rows = await experimentDb.events.where('runId').equals(run.id).toArray()
    expect(rows.filter(row => row.kind === 'experiment.stop')).toHaveLength(1)
    expect(rows.filter(row => row.kind === 'gps.request').map(row => row.source)).toEqual(['watch'])
    expect(onError).not.toHaveBeenCalled()
  })

  it('runs the same cleanup when the test reaches its time limit', async () => {
    recorder!.start()
    vi.setSystemTime(run.startedAt + LIMIT_MS)
    vi.advanceTimersByTime(5_000)
    await recorder!.stop()

    expect(onStop).toHaveBeenCalledTimes(1)
    expect(clearWatch).toHaveBeenCalledExactlyOnceWith(77)
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(await experimentDb.events.where('runId').equals(run.id).filter(row => row.kind === 'experiment.stop').toArray())
      .toMatchObject([{ detail: 'time-limit' }])
  })

  it('stops the audio experiment and GPS watch when geolocation permission is denied', async () => {
    recorder!.start()
    gpsFailure({ code: 1, message: 'Permission denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 })
    await recorder!.stop()

    expect(onStop).toHaveBeenCalledTimes(1)
    expect(clearWatch).toHaveBeenCalledExactlyOnceWith(77)
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Доступ к геолокации запрещён'))
    const rows = await experimentDb.events.where('runId').equals(run.id).toArray()
    expect(rows.find(row => row.kind === 'gps.error')).toMatchObject({ source: 'watch', detail: '1: Permission denied' })
    expect(rows.find(row => row.kind === 'experiment.stop')).toMatchObject({ detail: 'permission-denied' })
  })

  it('preserves original buffered media receipt time and visibility separately from replay storage', async () => {
    recorder!.start()
    recorder!.recordExternalEvent({
      kind: 'audio.timeupdate', receivedAt: 999_000, monotonicAt: 998_950,
      visibility: 'hidden', detail: 'currentTime=12',
    })
    await recorder!.stop()
    recorder!.recordExternalEvent({ kind: 'audio.timeupdate', receivedAt: 1_000_001, monotonicAt: 1_000_001, visibility: 'visible' })

    const rows = await experimentDb.events.where('runId').equals(run.id).filter(row => row.kind === 'audio.timeupdate').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      receivedAt: 999_000, monotonicAt: 998_950, visibility: 'hidden', detail: 'currentTime=12',
      committedAt: 1_000_000, persistedVisibility: 'visible',
    })
  })
})
