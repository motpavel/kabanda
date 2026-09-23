import { useSyncExternalStore } from 'react'
import { cityArchiveStore } from './archive-store'
import { IZHEVSK_ARCHIVE } from './manifest'
import './offline-map.css'

export function OfflineMapStatus() {
  const state = useSyncExternalStore(cityArchiveStore.subscribe, cityArchiveStore.getSnapshot)
  const download = () => { void cityArchiveStore.ensure(IZHEVSK_ARCHIVE, { manual: true }) }
  if (state.status === 'ready') return <div className="offline-map-status offline-map-status--ready"><span aria-hidden="true">✓</span> Ижевск сохранён</div>
  if (state.status === 'checking') return null
  if (state.status === 'downloading') return <div className="offline-map-status" role="status">
    <span>Сохраняем Ижевск · {Math.floor(state.progress)}%</span>
    <progress value={state.progress} max={100} aria-label="Сохранение карты Ижевска" />
  </div>
  if (state.status === 'error') return <div className="offline-map-status offline-map-status--error">
    <span>{state.error}</span><button type="button" onClick={download}>Повторить</button>
  </div>
  return <div className="offline-map-status"><button type="button" onClick={download}>Скачать Ижевск · 22 МБ</button></div>
}
