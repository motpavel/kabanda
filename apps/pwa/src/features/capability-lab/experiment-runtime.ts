import {
  experimentDb, EXPERIMENT_DB, LIMIT_MS,
  type ExperimentEvent, type ExperimentRun,
} from './experiment-data'

export function createExperimentRecorder(run: ExperimentRun, notify: () => void, onError: (message: string) => void) {
  let alive = true
  let watch: number | null = null
  let worker: Worker | null = null
  let wake: WakeLockSentinel | null = null
  let pollPending = false
  let queue: Promise<void> = Promise.resolve()
  let stopPromise: Promise<void> | null = null
  const timers: ReturnType<typeof setInterval>[] = []
  const removers: (() => void)[] = []
  let lastWall = Date.now()
  let lastMono = performance.timeOrigin + performance.now()

  const log = (kind: string, extra: Partial<ExperimentEvent> = {}) => {
    const row: ExperimentEvent = {
      id: crypto.randomUUID(), runId: run.id, kind,
      receivedAt: Date.now(), monotonicAt: performance.timeOrigin + performance.now(),
      visibility: document.visibilityState, ...extra,
    }
    queue = queue.then(async () => {
      await experimentDb.events.add(row)
      // Only an IDB transaction completion acknowledges the write. Capture this
      // separately from both the GPS timestamp and JS callback receipt time.
      await experimentDb.events.update(row.id, {
        committedAt: Date.now(), persistedVisibility: document.visibilityState,
      })
      notify()
    }).catch(error => {
      onError(`Не удалось сохранить журнал: ${String(error)}`)
      void stop('storage-error')
    })
  }
  const bind = (target: EventTarget, type: string, handler: EventListener) => {
    target.addEventListener(type, handler)
    removers.push(() => target.removeEventListener(type, handler))
  }
  const withinLimit = () => {
    if (!alive) return false
    if (Date.now() - run.startedAt >= LIMIT_MS) {
      void stop('time-limit')
      return false
    }
    return true
  }
  const fix = (source: string, position: GeolocationPosition) => {
    if (!withinLimit()) return
    log('gps.fix', {
      source, capturedAt: position.timestamp, latitude: position.coords.latitude,
      longitude: position.coords.longitude, accuracy: position.coords.accuracy,
    })
  }
  const failure = (source: string, error: GeolocationPositionError) => {
    if (!alive) return
    log('gps.error', { source, detail: `${error.code}: ${error.message}` })
    if (error.code === 1) {
      onError('Доступ к геолокации запрещён. Разрешите его в настройках и запустите новый тест.')
      void stop('permission-denied')
    }
    // A timeout/unavailable fix must not end the experiment or its active watch.
  }
  const poll = () => {
    if (!withinLimit() || pollPending) return
    pollPending = true
    log('gps.request', { source: 'poll' })
    navigator.geolocation.getCurrentPosition(position => {
      pollPending = false
      fix('poll', position)
    }, error => {
      pollPending = false
      failure('poll', error)
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 })
  }
  const requestWake = async () => {
    if (!run.keepScreen || !alive || document.visibilityState !== 'visible') return
    if (!navigator.wakeLock) { log('wake.unsupported'); return }
    try {
      const acquired = await navigator.wakeLock.request('screen')
      if (!alive || document.visibilityState !== 'visible') { await acquired.release(); return }
      wake = acquired
      log('wake.acquired')
      acquired.addEventListener('release', () => {
        if (wake === acquired) wake = null
        if (alive) log('wake.released')
      })
    } catch (error) { if (alive) log('wake.error', { detail: String(error) }) }
  }
  const stop = (reason = 'user') => {
    if (stopPromise) return stopPromise
    alive = false
    if (watch !== null) navigator.geolocation.clearWatch(watch)
    worker?.terminate()
    timers.forEach(clearInterval)
    removers.forEach(remove => remove())
    void wake?.release().catch(() => undefined)
    log('experiment.stop', { detail: reason })
    const pending = queue
    stopPromise = pending.then(async () => {
      await experimentDb.runs.update(run.id, { endedAt: Date.now() })
      notify()
    }).catch(error => onError(String(error)))
    return stopPromise
  }

  const start = () => {
    log('experiment.start', { detail: run.mode })
    bind(document, 'visibilitychange', () => {
      log(`visibility.${document.visibilityState}`)
      if (!withinLimit()) return
      // Deliberately keep GPS subscriptions while hidden. Browser behavior is
      // what this test measures; no application visibility gate stops them.
      if (document.visibilityState === 'visible') {
        if (!wake) void requestWake()
        log('page.resume')
      }
    })
    for (const event of ['pagehide', 'pageshow', 'online', 'offline']) {
      bind(window, event, () => { log(`page.${event}`); withinLimit() })
    }
    bind(document, 'freeze', () => log('page.freeze'))
    bind(document, 'resume', () => { log('page.resume'); withinLimit() })
    timers.push(setInterval(() => {
      if (!withinLimit()) return
      const wall = Date.now()
      const mono = performance.timeOrigin + performance.now()
      const difference = (wall - lastWall) - (mono - lastMono)
      if (Math.abs(difference) > 2_000) log('clock.divergence', { detail: String(Math.round(difference)) })
      log('page.tick', { detail: String(wall - lastWall) })
      lastWall = wall
      lastMono = mono
    }, 5_000))
    try {
      worker = new Worker(new URL('./experiment-worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = event => {
        if (!alive) return
        if (event.data.ready) log('worker.ready', { detail: `geolocation=${event.data.gpsAvailable}` })
        if (event.data.error) log('worker.error', { detail: String(event.data.error) })
        if (event.data.tick) notify()
      }
      worker.onerror = event => { if (alive) log('worker.error', { detail: event.message }) }
      worker.postMessage({ database: EXPERIMENT_DB, runId: run.id, startedAt: run.startedAt, limitMs: LIMIT_MS })
    } catch (error) { log('worker.error', { detail: String(error) }) }
    void requestWake()
    if (!navigator.geolocation) {
      onError('На этом устройстве GPS API недоступен.')
      void stop('gps-unavailable')
      return
    }
    if (run.mode !== 'poll') {
      log('gps.request', { source: 'watch' })
      watch = navigator.geolocation.watchPosition(position => fix('watch', position), error => failure('watch', error), {
        enableHighAccuracy: true, maximumAge: 0, timeout: 12_000,
      })
    }
    if (run.mode !== 'watch') {
      poll()
      timers.push(setInterval(poll, 10_000))
    }
  }
  return { start, stop, get active() { return alive } }
}
