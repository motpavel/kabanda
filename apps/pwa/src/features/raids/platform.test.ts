import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectLocalReadiness, currentCoordinate, locationRecoveryMessage } from './platform'
import { buildReadinessRows } from './state'

vi.mock('../offline/db', () => ({ offlineDb: {
  transaction: async (_mode: string, _table: unknown, run: () => Promise<void>) => run(),
  identities: { get: async () => ({ id: 'identity' }), put: async () => undefined },
} }))

let success: PositionCallback
let failure: PositionErrorCallback
let watch: ReturnType<typeof vi.fn>
let clearWatch: ReturnType<typeof vi.fn>
const position = (ageMs = 0, accuracy = 15): GeolocationPosition => ({
  timestamp: Date.now() - ageMs,
  coords: { latitude: 56.86, longitude: 53.2, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
}) as GeolocationPosition
const error = (code: number) => ({ code, message: 'Browser error' }) as GeolocationPositionError

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-05T12:00:00Z'))
  clearWatch = vi.fn()
  watch = vi.fn((onPosition: PositionCallback, onError: PositionErrorCallback) => {
    success = onPosition
    failure = onError
    return 42
  })
  vi.stubGlobal('navigator', {
    geolocation: { watchPosition: watch, clearWatch },
    onLine: true,
    permissions: { query: async () => ({ state: 'prompt' }) },
  })
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('fresh readiness geolocation', () => {
  it('ignores an old or coarse first fix and resolves only a fresh accurate update', async () => {
    const pending = currentCoordinate()
    const resolved = vi.fn()
    void pending.then(resolved)
    success(position(40_000))
    success(position(0, 400))
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    success(position())
    expect(await pending).toEqual({ coordinateMeasuredAt: new Date().toISOString(), accuracyM: 15, locationIssue: null })
    expect(watch).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 })
    expect(clearWatch).toHaveBeenCalledOnce()
    expect(clearWatch).toHaveBeenCalledWith(42)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['stale', () => success(position(40_000))],
    ['inaccurate', () => success(position(0, 101))],
    ['unavailable', () => failure(error(2))],
    ['timeout', () => failure(error(3))],
  ] as const)('bounds %s recovery without submitting a fake or old coordinate', async (issue, emit) => {
    const pending = currentCoordinate()
    emit()
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await pending).toEqual({ coordinateMeasuredAt: null, accuracyM: null, locationIssue: issue })
    expect(clearWatch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(locationRecoveryMessage(issue).length).toBeGreaterThan(30)
  })

  it('recovers after a transient provider error within the same attempt', async () => {
    const pending = currentCoordinate()
    failure(error(2))
    await vi.advanceTimersByTimeAsync(3_000)
    success(position())
    expect((await pending).locationIssue).toBeNull()
  })

  it('reports a prompt denial even if the permission query initially said prompt', async () => {
    const pending = collectLocalReadiness('identity')
    await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce())
    failure(error(1))
    const facts = await pending
    expect(facts.locationPermission).toBe('denied')
    expect(facts.locationIssue).toBe('denied')
    expect(buildReadinessRows(facts).find(row => row.id === 'location')).toMatchObject({
      status: 'fail', detail: expect.stringContaining('настройках'),
    })
    expect(clearWatch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts a new watch on retry after denial, without retaining the prior result', async () => {
    const first = currentCoordinate()
    failure(error(1))
    expect((await first).locationIssue).toBe('denied')
    const retry = currentCoordinate()
    success(position())
    expect((await retry).locationIssue).toBeNull()
    expect(watch).toHaveBeenCalledTimes(2)
    expect(clearWatch).toHaveBeenCalledTimes(2)
  })

  it('cleans up when leaving the screen and ignores late callbacks', async () => {
    const controller = new AbortController()
    const pending = currentCoordinate(controller.signal)
    controller.abort()
    success(position())
    expect((await pending).locationIssue).toBe('aborted')
    expect(clearWatch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start GPS for an already aborted request or unsupported browser', async () => {
    const controller = new AbortController()
    controller.abort()
    expect((await currentCoordinate(controller.signal)).locationIssue).toBe('aborted')
    expect(watch).not.toHaveBeenCalled()
    vi.stubGlobal('navigator', {})
    expect((await currentCoordinate()).locationIssue).toBe('unsupported')
  })

  it('clears the watch when a browser shim immediately invokes the callback', async () => {
    watch.mockImplementation((callback: PositionCallback) => { callback(position()); return 9 })
    expect((await currentCoordinate()).locationIssue).toBeNull()
    expect(clearWatch).toHaveBeenCalledExactlyOnceWith(9)
    expect(vi.getTimerCount()).toBe(0)
  })
})
