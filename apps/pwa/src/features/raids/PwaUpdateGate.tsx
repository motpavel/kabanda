import { useEffect, useState } from 'react'
import { liveQuery } from 'dexie'
import { useRegisterSW } from 'virtual:pwa-register/react'
import {
  alphaDiagnosticsEnabled,
  durableWorkBucket,
  emitAlphaDiagnosticOnce,
  queueStallEvent,
  readServiceWorkerBuild,
  type QueueDiagnosticSnapshot,
} from '../../lib/diagnostics'
import { reconcileAndCountUnsyncedCheckInWork } from '../checkins/store'
import { readQueueDiagnosticSnapshots } from '../offline/diagnostics'
import {
  shouldDeferServiceWorkerUpdate,
  shouldShowServiceWorkerUpdateNotice,
} from './recording/state'
import { useRecordingRuntime } from './recording/runtime'
import { reconcileAndCountUnsyncedRouteWork } from './recording/store'

export function PwaUpdateGate() {
  const { phase, unsyncedCheckInWork } = useRecordingRuntime()
  const [durableUnsyncedWork, setDurableUnsyncedWork] = useState(0)
  useEffect(() => {
    const subscription = liveQuery(async () => {
      const [checkIns, route] = await Promise.all([
        reconcileAndCountUnsyncedCheckInWork(),
        reconcileAndCountUnsyncedRouteWork(),
      ])
      return checkIns + route
    }).subscribe({
      next: setDurableUnsyncedWork,
      error: () => setDurableUnsyncedWork(1),
    })
    return () => subscription.unsubscribe()
  }, [])
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true })
  const deferred = shouldDeferServiceWorkerUpdate(phase)

  useEffect(() => {
    if (!needRefresh || deferred) return
    void updateServiceWorker(true)
  }, [deferred, needRefresh, updateServiceWorker])

  useEffect(() => {
    if (!alphaDiagnosticsEnabled()) return
    let cancelled = false
    let previous = new Map<QueueDiagnosticSnapshot['queue'], QueueDiagnosticSnapshot>()
    const inspect = async () => {
      try {
        const snapshots = await readQueueDiagnosticSnapshots()
        if (cancelled) return
        for (const current of snapshots) {
          const event = queueStallEvent(current, previous.get(current.queue), navigator.onLine)
          if (event) {
            void emitAlphaDiagnosticOnce(
              `queue:${current.queue}:${current.oldestAt ?? 'none'}`,
              event,
            )
          }
        }
        previous = new Map(snapshots.map((snapshot) => [snapshot.queue, snapshot]))
      } catch {
        // Diagnostics must not turn an IndexedDB failure into an application failure.
      }
    }
    void inspect()
    const timer = window.setInterval(() => void inspect(), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!alphaDiagnosticsEnabled() || !needRefresh || !deferred || !('serviceWorker' in navigator)) return
    let cancelled = false
    void navigator.serviceWorker.ready.then(async (registration) => {
      const [activeSwBuild, waitingSwBuild] = await Promise.all([
        readServiceWorkerBuild(registration.active),
        readServiceWorkerBuild(registration.waiting),
      ])
      if (cancelled) return
      void emitAlphaDiagnosticOnce(
        `sw:waiting:${activeSwBuild ?? 'unknown'}:${waitingSwBuild ?? 'unknown'}`,
        {
          kind: 'sw_mismatch',
          state: 'waiting_deferred',
          durableWorkBucket: durableWorkBucket(Math.max(unsyncedCheckInWork, durableUnsyncedWork)),
          recorderActive: !['ineligible', 'paused', 'blocked', 'error'].includes(phase),
          activeSwBuild,
          waitingSwBuild,
        },
        { swBuild: activeSwBuild },
      )
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [deferred, durableUnsyncedWork, needRefresh, phase, unsyncedCheckInWork])

  useEffect(() => {
    if (!alphaDiagnosticsEnabled() || !('serviceWorker' in navigator)) return
    const changed = () => {
      const controller = navigator.serviceWorker.controller
      void readServiceWorkerBuild(controller).then((activeSwBuild) =>
        emitAlphaDiagnosticOnce(
          `sw:controller:${activeSwBuild ?? 'unknown'}`,
          {
            kind: 'sw_mismatch',
            state: controller ? 'controller_changed' : 'controller_missing',
            durableWorkBucket: durableWorkBucket(Math.max(unsyncedCheckInWork, durableUnsyncedWork)),
            recorderActive: !['ineligible', 'paused', 'blocked', 'error'].includes(phase),
            activeSwBuild,
            waitingSwBuild: null,
          },
          { swBuild: activeSwBuild },
        ),
      ).catch(() => undefined)
    }
    navigator.serviceWorker.addEventListener('controllerchange', changed)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', changed)
  }, [durableUnsyncedWork, phase, unsyncedCheckInWork])

  if (!shouldShowServiceWorkerUpdateNotice(needRefresh, phase)) return null
  return (
    <aside className="pwa-update-gate" role="status" aria-live="polite">
      <strong>Обновление подождёт</strong>
      <span>Установим новую версию автоматически после остановки активной записи маршрута.</span>
    </aside>
  )
}
