import { useEffect } from 'react'
import { getActiveIdentityId } from '../offline/ledger'
import { COMPLETED_REFRESH_MS, visitHistoryResource } from './view-resources'
import { canWarmHistory, createHistoryWarmupQueue, HISTORY_WARMUP_DELAY, nearbyHistoryIds, type HistoryAnchor, type HistoryMapPoint } from './history-warmup'

const enqueue = createHistoryWarmupQueue()
const attempted = new Map<string, number>()
const permitted = () => canWarmHistory(navigator.onLine, document.visibilityState === 'visible',
  (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string; downlink?: number } }).connection)

export function useNearbyPointHistory({ identityId, kabandaId, points, anchor, priorityPointId, active }: {
  identityId: string; kabandaId: string; points: readonly HistoryMapPoint[]; anchor?: HistoryAnchor | null; priorityPointId?: string | null; active: boolean
}) {
  // Live GPS/projection objects change frequently. Reschedule only when the
  // actual nearby set changes, not on every position tick or React render.
  const idsKey = JSON.stringify(active ? nearbyHistoryIds(points, anchor, priorityPointId) : [])
  useEffect(() => {
    if (!active || !identityId || !kabandaId) return
    const ids = JSON.parse(idsKey) as string[]
    if (!ids.length) return
    let cancelled = false, running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const allowed = () => !cancelled && permitted()
    const run = async () => {
      for (const id of ids) {
        if (!allowed()) return
        await enqueue(allowed, async () => {
          if (await getActiveIdentityId() !== identityId || !allowed()) return
          const key = JSON.stringify([identityId, kabandaId, id])
          // Failed/denied reads must not retry on every small camera move.
          if (Date.now() - (attempted.get(key) ?? -Infinity) < COMPLETED_REFRESH_MS) return
          const entry = visitHistoryResource(identityId, kabandaId, id)
          if (entry.state.status === 'access-error') return
          attempted.delete(key); attempted.set(key, Date.now())
          if (attempted.size > 256) attempted.delete(attempted.keys().next().value!)
          await entry.refreshIfStale(COMPLETED_REFRESH_MS)
        })
      }
    }
    const schedule = () => {
      clearTimeout(timer)
      if (!allowed() || running) return
      timer = setTimeout(() => {
        running = true
        void run().finally(() => { running = false })
      }, HISTORY_WARMUP_DELAY)
    }
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection
    schedule()
    window.addEventListener('online', schedule)
    document.addEventListener('visibilitychange', schedule)
    connection?.addEventListener('change', schedule)
    return () => {
      cancelled = true; clearTimeout(timer)
      window.removeEventListener('online', schedule)
      document.removeEventListener('visibilitychange', schedule)
      connection?.removeEventListener('change', schedule)
    }
  }, [identityId, kabandaId, idsKey, active])
}
