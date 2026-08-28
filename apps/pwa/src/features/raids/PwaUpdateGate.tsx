import { useEffect, useState } from 'react'
import { liveQuery } from 'dexie'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { reconcileAndCountUnsyncedCheckInWork } from '../checkins/store'
import { shouldDeferServiceWorkerUpdate } from './recording/state'
import { useRecordingRuntime } from './recording/runtime'

export function PwaUpdateGate() {
  const { phase, unsyncedCheckInWork } = useRecordingRuntime()
  const [durableUnsyncedWork, setDurableUnsyncedWork] = useState(0)
  useEffect(() => {
    const subscription = liveQuery(reconcileAndCountUnsyncedCheckInWork).subscribe({
      next: setDurableUnsyncedWork,
      error: () => setDurableUnsyncedWork(1),
    })
    return () => subscription.unsubscribe()
  }, [])
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true })
  if (!needRefresh) return null
  const deferred = shouldDeferServiceWorkerUpdate(phase, Math.max(unsyncedCheckInWork, durableUnsyncedWork))
  return (
    <aside className="pwa-update-gate" role="status" aria-live="polite">
      <strong>Доступна новая версия</strong>
      <span>{deferred ? 'Обновление отложено, пока маршрут или локальные материалы не синхронизированы.' : 'Можно безопасно обновить приложение.'}</span>
      {!deferred && <button type="button" onClick={() => void updateServiceWorker(true)}>Обновить</button>}
    </aside>
  )
}
