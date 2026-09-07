/** One subscription at a time; retry a stalled iOS watch without changing the writer lease. */
export function watchRecoveringPosition(
  geolocation: Geolocation,
  success: PositionCallback,
  failure: PositionErrorCallback,
): () => void {
  let stopped = false
  let watch: number | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let retryDelay = 5_000
  let retryPending = false
  const clearWatch = () => {
    generation += 1
    if (watch !== null) geolocation.clearWatch(watch)
    watch = null
  }
  const stop = () => {
    stopped = true
    clearTimeout(timer)
    clearWatch()
  }
  const retry = () => {
    if (stopped || retryPending) return
    retryPending = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      retryDelay = Math.min(retryDelay * 2, 30_000)
      subscribe()
    }, retryDelay)
  }
  const armWatchdog = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (stopped) return
      failure({ code: 3, message: 'Нет свежего GPS-сигнала', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 })
      retry()
    }, 20_000)
  }
  const subscribe = () => {
    if (stopped) return
    clearWatch()
    retryPending = false
    const current = generation
    armWatchdog()
    const onFailure: PositionErrorCallback = (error) => {
      if (stopped || generation !== current) return
      if (error.code === 1) stop() // Never keep prompting after an explicit denial.
      else retry()
      failure(error)
    }
    try {
      const id = geolocation.watchPosition((position) => {
        if (stopped || generation !== current) return
        const age = Date.now() - position.timestamp
        if (!Number.isFinite(age) || age < -5_000 || age > 5_000) return
        retryDelay = 5_000
        retryPending = false
        armWatchdog()
        success(position)
      }, onFailure, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 })
      if (stopped || generation !== current) geolocation.clearWatch(id)
      else watch = id
    } catch {
      onFailure({ code: 2, message: 'GPS временно недоступен', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 })
    }
  }
  subscribe()
  return stop
}
