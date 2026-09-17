/** Poll fresh GPS at most every five seconds; ignore callbacks after stop/recovery. */
export function watchRecoveringPosition(
  geolocation: Geolocation,
  success: PositionCallback,
  failure: PositionErrorCallback,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let retryDelay = 5_000
  let lastDeliveredAt = -Infinity
  const stop = () => {
    stopped = true
    generation += 1
    clearTimeout(timer)
    clearTimeout(watchdog)
  }
  const schedule = (delay: number) => {
    if (!stopped) timer = setTimeout(poll, delay)
  }
  const poll = () => {
    if (stopped) return
    const current = ++generation
    let settled = false
    const finish = () => {
      if (stopped || settled || current !== generation) return false
      settled = true
      clearTimeout(watchdog)
      return true
    }
    const onFailure: PositionErrorCallback = (error) => {
      if (!finish()) return
      if (error.code === 1) stop()
      else { schedule(retryDelay); retryDelay = Math.min(retryDelay * 2, 30_000) }
      failure(error)
    }
    // Some providers fail to deliver their timeout callback after a lifecycle pause.
    watchdog = setTimeout(() => onFailure({ code: 3, message: 'Нет свежего GPS-сигнала', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }), 20_000)
    try {
      geolocation.getCurrentPosition((position) => {
        if (!finish()) return
        schedule(5_000)
        const age = Date.now() - position.timestamp
        if (!Number.isFinite(age) || age < -5_000 || age > 5_000) return
        if (!Number.isFinite(position.coords.accuracy) || position.coords.accuracy > 50 || position.coords.accuracy < 0) return
        if (position.timestamp - lastDeliveredAt < 5_000) return
        retryDelay = 5_000
        lastDeliveredAt = position.timestamp
        success(position)
      }, onFailure, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 })
    } catch {
      onFailure({ code: 2, message: 'GPS временно недоступен', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 })
    }
  }
  poll()
  return stop
}
