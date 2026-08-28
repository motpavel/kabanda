import { useRegisterSW } from 'virtual:pwa-register/react'
import { shouldDeferServiceWorkerUpdate } from './recording/state'
import { useRecordingRuntime } from './recording/runtime'

export function PwaUpdateGate() {
  const { phase } = useRecordingRuntime()
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true })
  if (!needRefresh) return null
  const deferred = shouldDeferServiceWorkerUpdate(phase)
  return (
    <aside className="pwa-update-gate" role="status" aria-live="polite">
      <strong>Доступна новая версия</strong>
      <span>{deferred ? 'Обновление отложено, пока страница пишет маршрут.' : 'Можно безопасно обновить приложение.'}</span>
      {!deferred && <button type="button" onClick={() => void updateServiceWorker(true)}>Обновить</button>}
    </aside>
  )
}
