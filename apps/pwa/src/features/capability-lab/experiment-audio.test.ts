import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createExperimentAudio, type ExperimentAudioEvent } from './experiment-audio'

class FakeAudio extends EventTarget {
  src = ''
  currentTime = 0
  paused = true
  ended = false
  muted = false
  volume = 1
  readyState = 0
  preload = ''
  loop = true
  error: { code: number; message: string } | null = null
  play = vi.fn((): Promise<void> => Promise.resolve())
  pause = vi.fn(() => { this.paused = true })
  load = vi.fn()
  removeAttribute = vi.fn((name: string) => { if (name === 'src') this.src = '' })
}

describe('experiment audio', () => {
  let media: FakeAudio
  let events: ExperimentAudioEvent[]
  let onError: ReturnType<typeof vi.fn<(message: string) => void>>
  let session: { type: string }
  let clock: number
  let page: { visibilityState: DocumentVisibilityState }

  beforeEach(() => {
    media = new FakeAudio()
    events = []
    onError = vi.fn()
    session = { type: 'auto' }
    clock = 0
    page = { visibilityState: 'visible' }
    vi.stubGlobal('Audio', vi.fn(function () { return media }))
    vi.stubGlobal('document', page)
    vi.stubGlobal('navigator', { audioSession: session })
    vi.stubGlobal('performance', { timeOrigin: 1_000_000, now: () => clock })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:experiment-sound')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const create = () => createExperimentAudio(event => events.push(event), onError)

  it('uses a finite audible WAV and calls play synchronously in the start gesture', async () => {
    const audio = create()
    const start = audio.start()
    expect(media.play).toHaveBeenCalledOnce()
    expect(audio.start()).toBe(start)
    expect(session.type).toBe('playback')
    expect(media.loop).toBe(false)
    expect(media.muted).toBe(false)
    expect(media.src).toBe('blob:experiment-sound')

    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const header = new DataView(bytes.buffer)
    expect(blob.type).toBe('audio/wav')
    expect(header.getUint32(24, true)).toBe(8_000)
    expect(header.getUint16(34, true)).toBe(8)
    expect(header.getUint32(40, true)).toBe(8_000 * 15 * 60)
    expect(bytes.length).toBe(44 + 7_200_000)
    expect(new Set(bytes.subarray(8_000, 16_000)).size).toBeGreaterThan(20)
    expect(bytes[44]).toBe(128)
    expect(bytes.at(-1)).toBe(128)
    await start
    expect(events.some(event => event.kind === 'audio.play.confirmed')).toBe(true)
    audio.stop()
    expect(onError).not.toHaveBeenCalled()
  })

  it('cleans media, listeners and session once when stopped, including after natural end', async () => {
    const audio = create()
    await audio.start()
    media.ended = true
    media.dispatchEvent(new Event('ended'))
    audio.stop()
    const count = events.length
    media.dispatchEvent(new Event('pause'))
    media.dispatchEvent(new Event('timeupdate'))
    expect(events).toHaveLength(count)
    expect(events.filter(event => event.kind === 'audio.ended')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'audio.stop')).toHaveLength(1)
    expect(media.pause).toHaveBeenCalledOnce()
    expect(media.removeAttribute).toHaveBeenCalledWith('src')
    expect(media.load).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:experiment-sound')
    expect(session.type).toBe('auto')
  })

  it('cleans a rejected play and reports the failure only once', async () => {
    const reason = new DOMException('Playback is not allowed', 'NotAllowedError')
    media.play.mockRejectedValueOnce(reason)
    const audio = create()
    await expect(audio.start()).rejects.toBe(reason)
    media.error = { code: 4, message: 'Playback is not allowed' }
    media.dispatchEvent(new Event('error'))
    audio.stop()
    expect(onError).toHaveBeenCalledOnce()
    expect(events.filter(event => event.kind === 'audio.error')).toHaveLength(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
    expect(session.type).toBe('auto')
  })

  it('cancels promptly on stop and pauses again if the old play promise resolves late', async () => {
    let resolvePlay!: () => void
    media.play.mockReturnValueOnce(new Promise<void>(resolve => { resolvePlay = resolve }))
    const audio = create()
    const result = audio.start().catch(error => error)
    audio.stop()
    expect((await result).name).toBe('AbortError')
    resolvePlay()
    await Promise.resolve()
    expect(media.pause).toHaveBeenCalledTimes(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
    expect(events.some(event => event.kind === 'audio.play.confirmed')).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  })

  it('bounds an unresolved play request to eight seconds and contains a late rejection', async () => {
    vi.useFakeTimers()
    let rejectPlay!: (reason: Error) => void
    media.play.mockReturnValueOnce(new Promise<void>((_, reject) => { rejectPlay = reject }))
    const audio = create()
    const result = audio.start().catch(error => error)
    await vi.advanceTimersByTimeAsync(8_000)
    expect((await result).message).toContain('8 секунд')
    expect(onError).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
    rejectPlay(new Error('Late media error'))
    await Promise.resolve()
    expect(onError).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('throttles media clock logs and captures visibility without resuming paused media', async () => {
    const audio = create()
    await audio.start()
    media.currentTime = 1
    media.dispatchEvent(new Event('timeupdate'))
    clock = 4_999
    media.dispatchEvent(new Event('timeupdate'))
    page.visibilityState = 'hidden'
    clock = 5_000
    media.currentTime = 6
    media.dispatchEvent(new Event('timeupdate'))
    media.dispatchEvent(new Event('pause'))
    media.dispatchEvent(new Event('waiting'))
    const ticks = events.filter(event => event.kind === 'audio.timeupdate')
    expect(ticks).toHaveLength(2)
    expect(ticks[1].visibility).toBe('hidden')
    expect(ticks[1].monotonicAt).toBe(1_005_000)
    expect(JSON.parse(ticks[1].detail!)).toMatchObject({ currentTime: 6, volume: 1, muted: false })
    expect(events.some(event => event.kind === 'audio.pause')).toBe(true)
    expect(media.play).toHaveBeenCalledOnce()
    audio.stop()
  })

  it('still plays when AudioSession is unavailable or its setter fails', async () => {
    vi.stubGlobal('navigator', {})
    const unsupported = create()
    await unsupported.start()
    unsupported.stop()
    expect(events.some(event => event.kind === 'audio.session.unsupported')).toBe(true)
    vi.stubGlobal('navigator', { audioSession: { get type() { return 'auto' }, set type(_: string) { throw new Error('unsupported') } } })
    const rejected = create()
    await rejected.start()
    rejected.stop()
    expect(events.some(event => event.kind === 'audio.session.error')).toBe(true)
    expect(onError).not.toHaveBeenCalled()
  })
})
