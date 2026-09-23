import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('mobile Yandex SDK warmup', () => {
  const ready = vi.fn((success: () => void) => success())
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    ready.mockClear()
    vi.stubGlobal('window', { setTimeout, clearTimeout, ymaps: { ready } })
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('document', { visibilityState: 'visible' })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('yields to the initial screen and reuses the same SDK promise on map entry', async () => {
    const { scheduleYandexMapsWarmup, loadYandexMaps } = await import('./yandex-maps')
    scheduleYandexMapsWarmup('test')
    await vi.advanceTimersByTimeAsync(1499)
    expect(ready).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await loadYandexMaps('test')
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('cancels before leaving the home screen', async () => {
    const { scheduleYandexMapsWarmup } = await import('./yandex-maps')
    const cancel = scheduleYandexMapsWarmup('test')
    cancel()
    await vi.runAllTimersAsync()
    expect(ready).not.toHaveBeenCalled()
  })

  it('allows map entry to retry a failed background warmup', async () => {
    const { scheduleYandexMapsWarmup, loadYandexMaps } = await import('./yandex-maps')
    Object.assign(window, { ymaps: { ready: (_success: () => void, fail: (error: Error) => void) => fail(new Error('temporary failure')) } })
    scheduleYandexMapsWarmup('test')
    await vi.runAllTimersAsync()
    Object.assign(window, { ymaps: { ready } })
    await expect(loadYandexMaps('test')).resolves.toBe(window.ymaps)
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it.each([{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }])('respects a constrained connection: %j', async connection => {
    vi.stubGlobal('navigator', { onLine: true, connection })
    const { scheduleYandexMapsWarmup } = await import('./yandex-maps')
    scheduleYandexMapsWarmup('test')
    await vi.runAllTimersAsync()
    expect(ready).not.toHaveBeenCalled()
  })

  it('does not begin loading after the app moves into the background', async () => {
    const { scheduleYandexMapsWarmup } = await import('./yandex-maps')
    scheduleYandexMapsWarmup('test')
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    await vi.runAllTimersAsync()
    expect(ready).not.toHaveBeenCalled()
  })

  it('cancels an already scheduled idle callback', async () => {
    let idleCallback!: () => void
    const cancelIdleCallback = vi.fn()
    Object.assign(window, { requestIdleCallback: (callback: () => void) => { idleCallback = callback; return 7 }, cancelIdleCallback })
    const { scheduleYandexMapsWarmup } = await import('./yandex-maps')
    const cancel = scheduleYandexMapsWarmup('test')
    await vi.runAllTimersAsync()
    cancel()
    idleCallback()
    expect(cancelIdleCallback).toHaveBeenCalledWith(7)
    expect(ready).not.toHaveBeenCalled()
  })
})
