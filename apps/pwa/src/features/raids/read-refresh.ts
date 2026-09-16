import { useEffect, useMemo, useRef } from 'react'

/** Share an in-flight read and coalesce focus/visibility events from one resume. */
export function coalescedRead(load: () => Promise<void>, now = Date.now) {
  let pending: Promise<void> | null = null
  let lastStarted = -Infinity
  return (force = true): Promise<void> => {
    if (pending) return pending
    if (!force && now() - lastStarted < 1_000) return Promise.resolve()
    lastStarted = now()
    pending = Promise.resolve().then(load).finally(() => { pending = null })
    return pending
  }
}

export function createReadPoller(refresh: (force?: boolean) => Promise<void>, allowed: () => boolean, intervalMs: number | null) {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const resume = async () => {
    if (stopped || !allowed()) return
    clearTimeout(timer)
    try { await refresh(false) } catch { /* The resource owns its error UI. */ }
    finally {
      clearTimeout(timer)
      if (!stopped && intervalMs !== null) timer = setTimeout(() => void resume(), intervalMs)
    }
  }
  return {
    resume,
    stop() { stopped = true; clearTimeout(timer) },
  }
}

/** Poll only the visible screen, with a full quiet interval after each response. */
export function useVisibleRead(load: () => Promise<void>, scope: string, active: boolean, intervalMs: number | null) {
  const latest = useRef(load)
  latest.current = load
  const refresh = useMemo(() => coalescedRead(() => latest.current()), [scope])
  useEffect(() => {
    if (!active) return
    const poller = createReadPoller(refresh, () => document.visibilityState === 'visible' && navigator.onLine, intervalMs)
    const resume = () => void poller.resume()
    resume()
    window.addEventListener('focus', resume)
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      poller.stop()
      window.removeEventListener('focus', resume)
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [active, intervalMs, refresh])
  return refresh
}
