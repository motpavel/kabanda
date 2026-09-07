export type ExperimentAudioEvent = {
  kind: string
  detail?: string
  receivedAt: number
  monotonicAt: number
  visibility: DocumentVisibilityState
}

const SAMPLE_RATE = 8_000
const DURATION_SECONDS = 15 * 60
const HEARTBEAT_MS = 5_000

// A finite, audible media file keeps playback independent from page timers.
// 8-bit mono PCM uses 7.2 MB for the complete 15-minute experiment.
function createSound() {
  const sampleCount = SAMPLE_RATE * DURATION_SECONDS
  const bytes = new Uint8Array(44 + sampleCount)
  const header = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i)
  }
  text(0, 'RIFF')
  header.setUint32(4, 36 + sampleCount, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, 1, true)
  header.setUint32(24, SAMPLE_RATE, true)
  header.setUint32(28, SAMPLE_RATE, true)
  header.setUint16(32, 1, true)
  header.setUint16(34, 8, true)
  text(36, 'data')
  header.setUint32(40, sampleCount, true)

  const period = new Uint8Array(SAMPLE_RATE * 4)
  for (let i = 0; i < period.length; i += 1) {
    const t = i / SAMPLE_RATE
    const chord = 0.6 * Math.sin(2 * Math.PI * 220 * t)
      + 0.25 * Math.sin(2 * Math.PI * 275 * t)
      + 0.15 * Math.sin(2 * Math.PI * 330 * t)
    const breath = 0.8 + 0.2 * Math.cos(2 * Math.PI * t / 4)
    period[i] = Math.round(128 + 23 * breath * chord)
  }
  for (let offset = 0; offset < sampleCount; offset += period.length) {
    bytes.set(period.subarray(0, Math.min(period.length, sampleCount - offset)), 44 + offset)
  }
  const fadeSamples = SAMPLE_RATE / 2
  for (let i = 0; i < fadeSamples; i += 1) {
    const gain = i / fadeSamples
    for (const index of [44 + i, bytes.length - 1 - i]) {
      bytes[index] = Math.round(128 + (bytes[index] - 128) * gain)
    }
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

export function createExperimentAudio(
  onEvent: (event: ExperimentAudioEvent) => void,
  onError: (message: string) => void,
) {
  const element = new Audio()
  const objectUrl = URL.createObjectURL(createSound())
  const removers: (() => void)[] = []
  let stopped = false
  let failed = false
  let startPromise: Promise<void> | null = null
  let cancelStart: ((reason: Error) => void) | null = null
  let lastHeartbeat = -Infinity
  let restoreSession: (() => void) | null = null

  const emit = (kind: string, extra: Record<string, unknown> = {}) => {
    onEvent({
      kind,
      receivedAt: Date.now(),
      monotonicAt: performance.timeOrigin + performance.now(),
      visibility: document.visibilityState,
      detail: JSON.stringify({
        currentTime: element.currentTime,
        paused: element.paused,
        ended: element.ended,
        muted: element.muted,
        volume: element.volume,
        readyState: element.readyState,
        ...extra,
      }),
    })
  }
  const stop = () => {
    if (stopped) return
    emit('audio.stop')
    stopped = true
    cancelStart?.(new DOMException('Воспроизведение остановлено', 'AbortError'))
    removers.forEach(remove => remove())
    element.pause()
    element.removeAttribute('src')
    element.load()
    URL.revokeObjectURL(objectUrl)
    restoreSession?.()
  }
  const fail = (error: unknown) => {
    if (stopped || failed) return
    failed = true
    const message = error instanceof Error ? error.message : String(error)
    emit('audio.error', { message, code: element.error?.code })
    stop()
    onError(`Звук не запустился или был прерван: ${message}`)
  }
  const bind = (type: string, handler: EventListener) => {
    element.addEventListener(type, handler)
    removers.push(() => element.removeEventListener(type, handler))
  }
  for (const type of ['play', 'playing', 'pause', 'waiting', 'stalled', 'volumechange']) {
    bind(type, () => { if (!stopped) emit(`audio.${type}`) })
  }
  bind('timeupdate', () => {
    const now = performance.now()
    if (stopped || now - lastHeartbeat < HEARTBEAT_MS) return
    lastHeartbeat = now
    // A media clock observed by JS is not evidence of a background GPS fix.
    emit('audio.timeupdate')
  })
  bind('ended', () => { if (!stopped) { emit('audio.ended'); stop() } })
  bind('error', () => fail(element.error?.message || 'Ошибка воспроизведения'))

  element.preload = 'auto'
  element.loop = false
  element.muted = false
  element.src = objectUrl

  const start = () => {
    if (startPromise) return startPromise
    if (stopped) return Promise.reject(new DOMException('Воспроизведение остановлено', 'AbortError'))
    try {
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
      if (session) {
        const previous = session.type
        session.type = 'playback'
        restoreSession = () => {
          try { if (session.type === 'playback') session.type = previous }
          catch { /* Session restoration must not prevent audio teardown. */ }
        }
        emit('audio.session', { type: session.type })
      } else {
        emit('audio.session.unsupported')
      }
    } catch (error) {
      emit('audio.session.error', { message: String(error) })
    }

    emit('audio.start', { durationSeconds: DURATION_SECONDS })
    try {
      // Keep this call synchronous in the click handler, before DB writes or awaits.
      const playback = element.play()
      const pendingPlay = Promise.resolve(playback).then(() => {
        if (stopped) {
          element.pause()
          throw new DOMException('Воспроизведение остановлено', 'AbortError')
        }
        emit('audio.play.confirmed')
      })
      let timeout: ReturnType<typeof setTimeout>
      const boundedStart = new Promise<never>((_, reject) => {
        cancelStart = reject
        timeout = setTimeout(() => reject(new Error('Не удалось начать воспроизведение за 8 секунд')), 8_000)
      })
      startPromise = Promise.race([pendingPlay, boundedStart]).catch(error => {
        fail(error)
        throw error
      }).finally(() => {
        clearTimeout(timeout)
        cancelStart = null
      })
    } catch (error) {
      fail(error)
      startPromise = Promise.reject(error)
    }
    return startPromise
  }

  return { start, stop, element }
}
