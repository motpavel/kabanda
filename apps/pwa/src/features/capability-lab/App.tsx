import { useCallback, useEffect, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import {
  STALE_AFTER_MS,
  formatBytes,
  getCapabilitySnapshot,
  getRecorderFreshness,
} from './capabilities'
import { appendEvent, db, getOrCreateSession } from './db'
import { buildEvidenceBundle, buildGeoJson, downloadJson } from './evidence'
import type {
  CapabilityEvent,
  CapabilitySession,
  CapabilitySnapshot,
  GpsSample,
  RecorderStatus,
} from './types'

const statusCopy: Record<RecorderStatus, string> = {
  idle: 'Не запущена',
  starting: 'Ищем координату',
  recording: 'Маршрут записывается',
  stale: 'GPS устарел',
  stopped: 'Запись остановлена',
  error: 'Ошибка GPS',
}

export function CapabilityLabPage() {
  const [session, setSession] = useState<CapabilitySession | null>(null)
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null)
  const [events, setEvents] = useState<CapabilityEvent[]>([])
  const [sampleCount, setSampleCount] = useState(0)
  const [latestSample, setLatestSample] = useState<GpsSample | null>(null)
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus>('idle')
  const [storage, setStorage] = useState<StorageEstimate | null>(null)
  const [storagePersisted, setStoragePersisted] = useState<boolean | null>(null)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [cameraPreview, setCameraPreview] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [bootError, setBootError] = useState('')
  const watchIdRef = useRef<number | null>(null)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const recorderStatusRef = useRef<RecorderStatus>('idle')
  const latestSampleAtRef = useRef<string | null>(null)

  const {
    offlineReady: [offlineReady],
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisterError(error) {
      setMessage(`Service worker: ${error.message}`)
    },
  })

  useEffect(() => {
    recorderStatusRef.current = recorderStatus
  }, [recorderStatus])

  const refreshLocalState = useCallback(async (sessionId: string) => {
    const [storedEvents, samples, estimate, persisted] = await Promise.all([
      db.events.where('sessionId').equals(sessionId).sortBy('recordedAt'),
      db.samples.where('sessionId').equals(sessionId).sortBy('capturedAt'),
      navigator.storage?.estimate?.(),
      navigator.storage?.persisted?.(),
    ])
    setEvents(storedEvents.slice(-30).reverse())
    setSampleCount(samples.length)
    const storedLatestSample = samples.at(-1) ?? null
    latestSampleAtRef.current = storedLatestSample?.capturedAt ?? null
    setLatestSample(storedLatestSample)
    setStorage(estimate ?? null)
    setStoragePersisted(persisted ?? null)
  }, [])

  const recordEvent = useCallback(
    async (type: string, detail: CapabilityEvent['detail'] = {}) => {
      if (!session) return
      await appendEvent(session.id, type, detail)
      await refreshLocalState(session.id)
    },
    [refreshLocalState, session],
  )

  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        const currentSnapshot = getCapabilitySnapshot()
        const currentSession = await getOrCreateSession(currentSnapshot.displayMode)
        if (cancelled) return
        setSnapshot(currentSnapshot)
        setSession(currentSession)
        await appendEvent(currentSession.id, 'app.boot', {
          online: navigator.onLine,
          visibility: document.visibilityState,
          displayMode: currentSnapshot.displayMode,
        })
        await refreshLocalState(currentSession.id)
      } catch (error) {
        if (cancelled) return
        setBootError(
          error instanceof Error
            ? `IndexedDB не открылась: ${error.message}`
            : 'IndexedDB не открылась по неизвестной причине',
        )
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [refreshLocalState])

  useEffect(() => {
    if (!session) return

    const logLifecycle = (type: string) => {
      void appendEvent(session.id, type, {
        online: navigator.onLine,
        visibility: document.visibilityState,
      }).then(() => refreshLocalState(session.id))
      setSnapshot(getCapabilitySnapshot())
    }
    const onVisibility = () => logLifecycle(`lifecycle.visibility.${document.visibilityState}`)
    const onOnline = () => logLifecycle('network.online')
    const onOffline = () => logLifecycle('network.offline')
    const onPageHide = () => logLifecycle('lifecycle.pagehide')
    const onPageShow = () => logLifecycle('lifecycle.pageshow')
    const onInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
      logLifecycle('install.available')
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('beforeinstallprompt', onInstallPrompt)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('beforeinstallprompt', onInstallPrompt)
    }
  }, [refreshLocalState, session])

  useEffect(() => {
    if (!session || !['starting', 'recording', 'stale'].includes(recorderStatus)) return
    const timer = window.setInterval(() => {
      const freshness = getRecorderFreshness(latestSample?.capturedAt ?? null)
      setRecorderStatus(freshness)
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [latestSample?.capturedAt, recorderStatus, session])

  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) {
      setMessage('Wake Lock не поддерживается')
      await recordEvent('wake-lock.unsupported')
      return
    }
    try {
      const sentinel = await navigator.wakeLock.request('screen')
      wakeLockRef.current = sentinel
      setWakeLockActive(true)
      sentinel.addEventListener('release', () => {
        setWakeLockActive(false)
        void recordEvent('wake-lock.released')
      })
      await recordEvent('wake-lock.acquired')
    } catch (error) {
      setWakeLockActive(false)
      setMessage(error instanceof Error ? error.message : 'Не удалось включить Wake Lock')
      await recordEvent('wake-lock.failed')
    }
  }, [recordEvent])

  const releaseWakeLock = useCallback(async () => {
    await wakeLockRef.current?.release()
    wakeLockRef.current = null
    setWakeLockActive(false)
  }, [])

  const startRecording = useCallback(async () => {
    if (!session || !navigator.geolocation || watchIdRef.current !== null) return
    setRecorderStatus('starting')
    await recordEvent('gps.start-requested')
    await requestWakeLock()

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const sample: GpsSample = {
          id: crypto.randomUUID(),
          sessionId: session.id,
          capturedAt: new Date(position.timestamp).toISOString(),
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          altitude: position.coords.altitude,
          altitudeAccuracy: position.coords.altitudeAccuracy,
          heading: position.coords.heading,
          speed: position.coords.speed,
        }
        void db.samples.add(sample).then(async () => {
          const previousSampleAt = latestSampleAtRef.current
          latestSampleAtRef.current = sample.capturedAt
          setLatestSample(sample)
          setSampleCount((count) => count + 1)
          setRecorderStatus('recording')
          await appendEvent(session.id, 'gps.sample', {
            accuracy: Math.round(sample.accuracy),
            gapMs: previousSampleAt
              ? Date.parse(sample.capturedAt) - Date.parse(previousSampleAt)
              : 0,
          })
        })
      },
      (error) => {
        setRecorderStatus('error')
        setMessage(`${error.code}: ${error.message}`)
        void appendEvent(session.id, 'gps.error', { code: error.code, message: error.message })
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: STALE_AFTER_MS,
      },
    )
  }, [recordEvent, requestWakeLock, session])

  const stopRecording = useCallback(async () => {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current)
    watchIdRef.current = null
    setRecorderStatus('stopped')
    await releaseWakeLock()
    await recordEvent('gps.stopped', { sampleCount })
  }, [recordEvent, releaseWakeLock, sampleCount])

  const requestPersistentStorage = async () => {
    if (!navigator.storage?.persist) return
    const granted = await navigator.storage.persist()
    setStoragePersisted(granted)
    await recordEvent('storage.persist-result', { granted })
  }

  const install = async () => {
    if (!installPrompt) return
    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    await recordEvent('install.choice', { outcome: choice.outcome, platform: choice.platform })
    setInstallPrompt(null)
  }

  const exportEvidence = async () => {
    if (!session || !snapshot) return
    const bundle = await buildEvidenceBundle(session.id, getCapabilitySnapshot())
    downloadJson(`kabanda-capability-${session.id}.json`, bundle)
    const samples = await db.samples.where('sessionId').equals(session.id).sortBy('capturedAt')
    downloadJson(`kabanda-route-${session.id}.geojson`, buildGeoJson(samples))
    await recordEvent('evidence.exported', { sampleCount: samples.length })
  }

  const shareEvidence = async () => {
    if (!session || !snapshot) return
    const bundle = await buildEvidenceBundle(session.id, getCapabilitySnapshot())
    const file = new File([JSON.stringify(bundle, null, 2)], 'kabanda-capability.json', {
      type: 'application/json',
    })
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: 'КАБАНДА capability evidence', files: [file] })
      } else if (navigator.share) {
        await navigator.share({
          title: 'КАБАНДА capability evidence',
          text: `Сессия ${session.label}: ${sampleCount} GPS samples`,
        })
      } else {
        downloadJson('kabanda-capability.json', bundle)
      }
      await recordEvent('share.completed')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setMessage(error instanceof Error ? error.message : 'Sharing не выполнен')
      await recordEvent('share.failed')
    }
  }

  const onCameraFile = async (file?: File) => {
    if (!file) return
    if (cameraPreview) URL.revokeObjectURL(cameraPreview)
    setCameraPreview(URL.createObjectURL(file))
    await recordEvent('camera.file-selected', {
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
    })
  }

  const clearSessionData = async () => {
    if (!session || !window.confirm('Удалить GPS samples и события текущей тестовой сессии?')) return
    await db.transaction('rw', db.samples, db.events, async () => {
      await db.samples.where('sessionId').equals(session.id).delete()
      await db.events.where('sessionId').equals(session.id).delete()
    })
    setSampleCount(0)
    setLatestSample(null)
    latestSampleAtRef.current = null
    setEvents([])
    setRecorderStatus('idle')
    setMessage('Данные тестовой сессии удалены')
  }

  const updateSession = async (updates: Pick<CapabilitySession, 'label' | 'notes'>) => {
    if (!session) return
    const updated = { ...session, ...updates, updatedAt: new Date().toISOString() }
    await db.sessions.put(updated)
    setSession(updated)
  }

  if (bootError) {
    return (
      <main className="loading">
        <section className="panel" role="alert">
          <p className="eyebrow">Capability failure</p>
          <h1>Локальный журнал недоступен</h1>
          <p>{bootError}</p>
          <p className="helper">
            Зафиксируйте устройство и режим браузера вручную. Не продолжайте полевой GPS-тест без
            работающего IndexedDB.
          </p>
        </section>
      </main>
    )
  }

  if (!session || !snapshot) {
    return <main className="loading">Открываем локальный журнал теста…</main>
  }

  const storageUsage = `${formatBytes(storage?.usage)} / ${formatBytes(storage?.quota)}`
  const recordingActive = ['starting', 'recording', 'stale'].includes(recorderStatus)

  return (
    <main>
      <header className="hero">
        <p className="eyebrow">VP 1/9 · PWA capability gate</p>
        <h1>КАБАНДА Lab</h1>
        <p>
          Полевой стенд не симулирует нативное приложение. Он записывает фактическое поведение
          установленной PWA и экспортирует проверяемый evidence.
        </p>
        <div className="status-row" aria-label="Текущее окружение">
          <span className={`status ${snapshot.online ? 'ok' : 'warn'}`}>
            {snapshot.online ? 'Сеть доступна' : 'Offline'}
          </span>
          <span className="status">{snapshot.displayMode}</span>
          <span className={`status ${wakeLockActive ? 'ok' : ''}`}>
            Wake Lock: {wakeLockActive ? 'активен' : 'нет'}
          </span>
          <span className="status">v{__APP_VERSION__}</span>
        </div>
      </header>

      {(offlineReady || needRefresh || installPrompt) && (
        <section className="notice" aria-live="polite">
          {offlineReady && <p>App shell готов к offline-запуску.</p>}
          {needRefresh && (
            <div>
              <p>
                Доступна новая версия. {recordingActive && 'Обновление отложено до остановки GPS.'}
              </p>
              <button disabled={recordingActive} onClick={() => void updateServiceWorker(true)}>
                Обновить безопасно
              </button>
            </div>
          )}
          {installPrompt && <button onClick={() => void install()}>Установить PWA</button>}
        </section>
      )}

      {message && (
        <section className="message" role="status">
          <span>{message}</span>
          <button className="text-button" onClick={() => setMessage('')}>
            Закрыть
          </button>
        </section>
      )}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Тестовая сессия</p>
            <h2>{session.label}</h2>
          </div>
          <span className="mono">{session.id.slice(0, 8)}</span>
        </div>
        <label>
          Название устройства и сценария
          <input
            value={session.label}
            onChange={(event) => void updateSession({ label: event.target.value, notes: session.notes })}
          />
        </label>
        <label>
          Заметки тестировщика
          <textarea
            rows={3}
            value={session.notes}
            onChange={(event) => void updateSession({ label: session.label, notes: event.target.value })}
            placeholder="Например: iPhone 15, iOS 19, standalone, экран заблокирован на 10 минут"
          />
        </label>
      </section>

      <section className="panel recorder-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">GPS recorder</p>
            <h2>{statusCopy[recorderStatus]}</h2>
          </div>
          <span className={`recorder-dot ${recorderStatus}`} aria-hidden="true" />
        </div>

        <dl className="metrics">
          <div>
            <dt>Samples</dt>
            <dd>{sampleCount}</dd>
          </div>
          <div>
            <dt>Последний</dt>
            <dd>{latestSample ? new Date(latestSample.capturedAt).toLocaleTimeString('ru-RU') : '—'}</dd>
          </div>
          <div>
            <dt>Точность</dt>
            <dd>{latestSample ? `${Math.round(latestSample.accuracy)} м` : '—'}</dd>
          </div>
          <div>
            <dt>Storage</dt>
            <dd>{storageUsage}</dd>
          </div>
        </dl>

        <div className="actions primary-actions">
          {!recordingActive ? (
            <button className="primary" onClick={() => void startRecording()}>
              Начать запись
            </button>
          ) : (
            <button className="danger" onClick={() => void stopRecording()}>
              Остановить запись
            </button>
          )}
          <button onClick={() => void (wakeLockActive ? releaseWakeLock() : requestWakeLock())}>
            {wakeLockActive ? 'Отпустить экран' : 'Удерживать экран'}
          </button>
        </div>

        <p className="helper">
          Зелёный статус появляется только после свежей координаты и становится stale через{' '}
          {STALE_AFTER_MS / 1000} секунд без нового sample.
        </p>
      </section>

      <section className="panel">
        <p className="eyebrow">Capability snapshot</p>
        <h2>Что действительно доступно</h2>
        <ul className="capability-grid">
          {Object.entries(snapshot).map(([key, value]) => (
            <li key={key}>
              <span>{key}</span>
              <strong>{String(value)}</strong>
            </li>
          ))}
        </ul>
        <div className="actions">
          <button disabled={!snapshot.storagePersist} onClick={() => void requestPersistentStorage()}>
            Запросить persistent storage
          </button>
          <span className="helper">
            Persistence: {storagePersisted === null ? 'не проверено' : storagePersisted ? 'да' : 'нет'}
          </span>
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Camera / file capture</p>
        <h2>Проверка фотографии</h2>
        <label className="file-button">
          Выбрать или снять фотографию
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => void onCameraFile(event.target.files?.[0])}
          />
        </label>
        {cameraPreview && <img className="preview" src={cameraPreview} alt="Тестовый снимок с устройства" />}
        <p className="helper">Файл не загружается в сеть и не сохраняется в IndexedDB.</p>
      </section>

      <section className="panel">
        <p className="eyebrow">Evidence</p>
        <h2>Экспорт результата</h2>
        <div className="actions">
          <button className="primary" onClick={() => void exportEvidence()}>
            Скачать JSON + GeoJSON
          </button>
          <button onClick={() => void shareEvidence()}>Проверить Web Share</button>
          <button className="danger-secondary" onClick={() => void clearSessionData()}>
            Очистить тест
          </button>
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Lifecycle ledger</p>
        <h2>Последние события</h2>
        {events.length === 0 ? (
          <p className="helper">Событий пока нет.</p>
        ) : (
          <ol className="event-list">
            {events.map((event) => (
              <li key={event.id}>
                <time dateTime={event.recordedAt}>
                  {new Date(event.recordedAt).toLocaleTimeString('ru-RU')}
                </time>
                <strong>{event.type}</strong>
                <code>{JSON.stringify(event.detail)}</code>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer>
        <p>
          Этот стенд не доказывает background GPS автоматически. Экран блокировки, suspension и
          battery mode проверяются физически по матрице из репозитория.
        </p>
      </footer>
    </main>
  )
}
