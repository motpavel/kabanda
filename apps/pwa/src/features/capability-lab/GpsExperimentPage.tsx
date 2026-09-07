import { useEffect, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { appPath } from '../../lib/paths'
import { downloadJson } from './evidence'
import { getCapabilitySnapshot } from './capabilities'
import { experimentDb, summarizeExperiment, type ExperimentEvent, type ExperimentMode, type ExperimentRun } from './experiment-data'
import { createExperimentRecorder } from './experiment-runtime'
import { createExperimentAudio } from './experiment-audio'
import './gps-experiment.css'

const modeLabels: Record<ExperimentMode, string> = {
  watch: 'A · Наблюдение за GPS', poll: 'B · Запрос каждые 10 секунд', combined: 'C · Оба способа вместе',
  audio: 'D · GPS + фоновое аудио',
}
type AudioEvent = Parameters<Parameters<typeof createExperimentAudio>[0]>[0]
type AudioStatus = 'off' | 'starting' | 'playing' | 'paused' | 'waiting' | 'ended' | 'error'
const audioStatusLabels: Record<AudioStatus, string> = {
  off: 'Звук остановлен', starting: 'Запускаем звук…', playing: 'Звук воспроизводится',
  paused: 'Звук на паузе', waiting: 'Звук ожидает воспроизведения', ended: 'Аудио закончилось', error: 'Ошибка воспроизведения',
}
const time = (value?: number) => value === undefined ? '—' : new Date(value).toLocaleTimeString('ru-RU', { hour12: false })
const duration = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1_000) % 60).padStart(2, '0')}`

export function GpsExperimentPage() {
  const [mode, setMode] = useState<ExperimentMode>('audio')
  const [audioStatus, setAudioStatus] = useState<AudioStatus>('off')
  const [keepScreen, setKeepScreen] = useState(true)
  const [runs, setRuns] = useState<ExperimentRun[]>([])
  const [run, setRun] = useState<ExperimentRun | null>(null)
  const [rows, setRows] = useState<ExperimentEvent[]>([])
  const [now, setNow] = useState(Date.now())
  const [active, setActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [ready, setReady] = useState(false)
  const [report, setReport] = useState<File | null>(null)
  const [persistent, setPersistent] = useState<boolean | null>(null)
  const runner = useRef<ReturnType<typeof createExperimentRecorder> | null>(null)
  const audio = useRef<ReturnType<typeof createExperimentAudio> | null>(null)
  const runId = useRef<string | null>(null)
  const mounted = useRef(true)
  const refreshing = useRef(false)
  const capabilities = getCapabilitySnapshot()
  const installed = capabilities.displayMode === 'standalone' || capabilities.displayMode === 'fullscreen'
  const installPageReady = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href
    === new URL(appPath('lab/manifest.webmanifest'), window.location.origin).href
  const { needRefresh: [needRefresh], offlineReady: [offlineReady], updateServiceWorker } = useRegisterSW({
    immediate: true,
    onRegisterError: registrationError => setError(`Не удалось подготовить офлайн-запуск: ${registrationError.message}`),
  })

  const refresh = async () => {
    if (refreshing.current || !mounted.current) return
    refreshing.current = true
    const id = runId.current
    try {
      const recent = await experimentDb.runs.orderBy('startedAt').reverse().limit(10).toArray()
      const selectedId = id ?? recent[0]?.id
      const selected = selectedId ? await experimentDb.runs.get(selectedId) : undefined
      const events = selected ? await experimentDb.events.where('runId').equals(selected.id).sortBy('receivedAt') : []
      if (!mounted.current || id !== runId.current) return
      setRuns(recent)
      setRun(selected ?? null)
      setRows(events)
      setActive(runner.current?.active ?? false)
      setNow(Date.now())
      if (selected && !runner.current?.active) {
        const bundle = {
          schemaVersion: 3, exportedAt: new Date().toISOString(), run: selected,
          interrupted: !selected.endedAt, capabilities: getCapabilitySnapshot(),
          summary: summarizeExperiment(events, selected.endedAt ?? Date.now()), events,
          clockNotes: 'receivedAt: callback receipt; capturedAt: device GPS timestamp; committedAt: after IndexedDB write completion. All epoch milliseconds. Worker visibility is inferred only from page lifecycle intervals.',
          audioNotes: 'audio.timeupdate proves only callback execution at receivedAt, not GPS or uninterrupted playback. Playback time read after return does not prove background JavaScript. confirmedHiddenFixes requires GPS capture, receipt and commit in the same hidden interval; sustainedHiddenFixes requires all three after its first 60 seconds.',
        }
        setReport(new File([JSON.stringify(bundle, null, 2)], `kabanda-gps-${selected.id}.json`, { type: 'application/json' }))
      }
    } catch (readError) {
      if (mounted.current) setError(`Не удалось прочитать локальный журнал: ${String(readError)}`)
    } finally { refreshing.current = false }
  }

  useEffect(() => {
    mounted.current = true
    const previousTitle = document.title
    document.title = 'Кабанда GPS'
    void experimentDb.open().then(async () => {
      if (!mounted.current) return
      setReady(true)
      setPersistent(await navigator.storage?.persisted?.() ?? null)
      await refresh()
    }).catch(bootError => setError(`Локальная память недоступна: ${String(bootError)}`))
    const timer = setInterval(() => { void refresh() }, 2_000)
    return () => {
      mounted.current = false
      clearInterval(timer)
      void runner.current?.stop('page-unmounted')
      audio.current?.stop()
      document.title = previousTitle
    }
    // Lifetime is this page, not a changing sample or selected run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = async () => {
    if (busy || runner.current?.active) return
    setBusy(true)
    setError('')
    setMessage('')
    setReport(null)
    let recorder: ReturnType<typeof createExperimentRecorder> | null = null
    let session: ReturnType<typeof createExperimentAudio> | null = null
    try {
      const next: ExperimentRun = {
        id: crypto.randomUUID(), startedAt: Date.now(), mode, keepScreen,
        displayMode: getCapabilitySnapshot().displayMode, userAgent: navigator.userAgent,
        version: __APP_VERSION__, persisted: persistent,
      }
      const earlyAudio: AudioEvent[] = []
      let playbackReady: Promise<boolean> = Promise.resolve(true)
      if (mode === 'audio') {
        setAudioStatus('starting')
        session = createExperimentAudio(event => {
          if (recorder) recorder.recordExternalEvent({ ...event, source: 'audio' })
          else earlyAudio.push(event)
          const state = event.kind.slice('audio.'.length)
          if (mounted.current && ['playing', 'paused', 'waiting', 'ended', 'error'].includes(state)) setAudioStatus(state as AudioStatus)
          if (mounted.current && event.kind === 'audio.pause') setAudioStatus('paused')
        }, detail => { if (mounted.current) setError(detail) })
        audio.current = session
        // Calling play before any await is essential for Safari user activation.
        // Catch immediately while IndexedDB creates the run; rejection is never unhandled.
        playbackReady = session.start().then(() => true, playbackError => {
          if (mounted.current) {
            setAudioStatus('error')
            setError(`Звук не запустился: ${String(playbackError)}. Запусти новый тест.`)
          }
          return false
        })
      }
      await experimentDb.runs.add(next)
      if (!mounted.current) { session?.stop(); return }
      runId.current = next.id
      setRun(next)
      setRows([])
      recorder = createExperimentRecorder(next, () => {}, detail => { if (mounted.current) setError(detail) }, () => {
        session?.stop()
        if (audio.current === session) audio.current = null
        if (mounted.current) setAudioStatus('off')
      })
      runner.current = recorder
      earlyAudio.forEach(event => recorder!.recordExternalEvent({ ...event, source: 'audio' }))
      if (!await playbackReady || !mounted.current) {
        await recorder.stop('audio-start-error')
        setActive(false)
        await refresh()
        return
      }
      recorder.start()
      setActive(recorder.active)
      setNow(Date.now())
      await refresh()
    } catch (startError) {
      session?.stop()
      await recorder?.stop('start-error')
      setError(String(startError))
    } finally { setBusy(false) }
  }
  const stop = async () => {
    setBusy(true)
    await runner.current?.stop()
    setActive(false)
    await refresh()
    setBusy(false)
  }
  const persist = async () => {
    try {
      const granted = await navigator.storage?.persist?.() ?? false
      setPersistent(granted)
      setMessage(granted ? 'Постоянное хранение разрешено.' : 'Браузер не предоставил постоянное хранение. Обычная локальная запись доступна.')
    } catch (persistError) { setError(String(persistError)) }
  }
  const share = async () => {
    if (!report) return
    try {
      if (navigator.canShare?.({ files: [report] })) await navigator.share({ files: [report], title: 'GPS-тест Кабанды' })
      else downloadReport()
    } catch (shareError) {
      if (!(shareError instanceof DOMException && shareError.name === 'AbortError')) setError('Не удалось поделиться. Нажмите «Скачать JSON».')
    }
  }
  const downloadReport = () => {
    if (!report) return
    const url = URL.createObjectURL(report)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = report.name
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
  const summary = summarizeExperiment(rows, run?.endedAt ?? now)
  const elapsed = run ? Math.max(0, (run.endedAt ?? now) - run.startedAt) : 0
  const hidden = summary.intervals.length > 0
  const firstFixAt = rows.find(row => row.kind === 'gps.fix')?.receivedAt
  const audioRun = run?.mode === 'audio'
  const canLock = active && firstFixAt !== undefined && now - firstFixAt >= 30_000 && (!audioRun || audioStatus === 'playing')
  const phase = !active ? 'Готов к эксперименту' : hidden ? 'После разблокировки подожди 30 секунд' : audioRun && audioStatus !== 'playing' ? 'Для этого теста нужен воспроизводящийся звук' : canLock ? 'Теперь заблокируй телефон на 3 минуты' : 'Оставь экран открытым на 30 секунд после первой точки'
  const summaryText = [
    `Кабанда GPS-тест ${run?.id ?? ''}`, `${run ? modeLabels[run.mode] : ''} · ${run?.displayMode ?? ''}`,
    `Точек: ${summary.fixCount}, уникальных: ${summary.uniqueFixCount}`,
    `Свежих точек получено в фоне: ${summary.freshHiddenFixes}`,
    `GPS-записей подтверждено в фоне: ${summary.hiddenStorageWrites}`,
    `Свежих уникальных GPS получено и сохранено в фоне: ${summary.confirmedHiddenFixes}`,
    `Из них после первой минуты скрытия: ${summary.sustainedHiddenFixes}`,
    `Пришли после открытия, время координаты из скрытого периода: ${summary.delayedFixes}`,
    `Подтверждённые записи таймера страницы / worker в фоне: ${summary.pageHiddenWrites} / ${summary.workerHiddenTicks}`,
    ...(audioRun ? [`Событий аудио получено и сохранено в фоне: ${summary.audioHiddenEvents}, ошибок аудио: ${summary.audioErrors}`] : []),
    `Скрыто: ${duration(summary.hiddenDurationMs)}, ошибок GPS: ${summary.errors}`,
    ...summary.intervals.map(interval => `${time(interval.start)} → ${time(interval.end)}${interval.open ? ' (нет события возврата)' : ''}`),
    'Тест на месте. Отсутствие фоновых точек не доказывает невозможность записи при движении.',
  ].join('\n')

  return <main className="gps-experiment">
    <header className="gps-experiment-header">
      <a href={appPath('app')} aria-label="Вернуться в Кабанду" onClick={event => { if (active) { event.preventDefault(); setMessage('Сначала остановите тест, чтобы сохранить полный отчёт.') } }}>← Кабанда</a>
      <span>ЛАБОРАТОРИЯ / V3</span>
    </header>
    <div className="gps-experiment-intro"><h1>GPS в фоне.<br />Теперь со звуком</h1><p>Проверим, меняет ли аудио запись координат при блокировке iPhone. Можно проверить дома.</p></div>
    <div className="gps-experiment-context"><span className={installed ? 'gps-experiment-ok' : ''}>{installed ? 'Установленная PWA' : 'Открыто в браузере'}</span><span>{offlineReady ? 'Готов к работе без сети' : navigator.onLine ? 'Интернет подключён' : 'Без интернета'}</span></div>
    {needRefresh && <div className="gps-experiment-notice">Доступна новая версия теста. <button disabled={active} onClick={() => void updateServiceWorker(true)}>Обновить</button></div>}
    {error && <div role="alert" className="gps-experiment-error">{error}</div>}
    {message && <p role="status" className="gps-experiment-notice">{message}</p>}
    {!installed && <section className="gps-experiment-card">
      <h2>Отдельный ярлык «Кабанда GPS»</h2>
      {installPageReady ? <>
        <p><strong>Страница установки GPS готова.</strong> В Safari открой «Поделиться» → «На экран Домой». Название должно быть «Кабанда GPS». Затем запусти новый ярлык.</p>
        <p className="gps-experiment-small">После запуска сверху появится «Установленная PWA». Значок с кабанчиком тот же; новый ярлык открывает сразу этот тест.</p>
      </> : <>
        <p>Сначала открой отдельную страницу установки. На текущей странице Safari может предложить обычную «Кабанду».</p>
        <button className="gps-experiment-primary" disabled={active} onClick={() => { window.location.href = appPath('lab/index.html') }}>Открыть страницу установки GPS</button>
      </>}
    </section>}
    <section className="gps-experiment-card">
      <h2>1. Выбери способ</h2>
      <label>Режим записи<select value={mode} disabled={active || busy} onChange={event => setMode(event.target.value as ExperimentMode)}>
        {Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <p>{mode === 'audio' ? 'Та же подписка на GPS, что в режиме A, и слышимый мягкий сигнал. Проверяем аудио внутри этой PWA; музыка в другом приложении не заменяет этот тест.' : mode === 'watch' ? 'Подписка остаётся включённой при блокировке. Временная ошибка GPS не завершает тест.' : mode === 'poll' ? 'Пробуем запрашивать свежую координату каждые 10 секунд. Браузер может задерживать запросы в фоне.' : 'Подписка и отдельные запросы работают вместе. Повторные координаты считаются отдельно.'}</p>
      {mode === 'audio' && <p className="gps-experiment-audio-note">После нажатия зазвучит сигнал. Установи небольшую слышимую громкость кнопками телефона. Микрофон не используется. Звук отключится вместе с тестом.</p>}
      <label className="gps-experiment-check"><input type="checkbox" checked={keepScreen} disabled={active || busy} onChange={event => setKeepScreen(event.target.checked)} />Не гасить открытый экран автоматически</label>
      <p className="gps-experiment-small">Боковая кнопка всё равно блокирует телефон. Каждый тест хранится отдельно. Ограничение — 15 минут; после заморозки остановка сработает при возобновлении.</p>
      <button className={active ? 'gps-experiment-stop' : 'gps-experiment-primary'} disabled={!ready || busy} onClick={() => void (active ? stop() : start())}>{busy ? 'Подготавливаем…' : active ? 'Остановить и сохранить результат' : mode === 'audio' ? 'Включить звук и начать тест' : 'Начать новый тест'}</button>
    </section>
    <section className="gps-experiment-card gps-experiment-live">
      <div className="gps-experiment-live-heading"><h2>{active ? '2. Тест идёт' : '2. Наблюдение'}</h2><strong>{duration(elapsed)}</strong></div>
      <p className="gps-experiment-phase" role="status">{phase}</p>
      {audioRun && <p className={`gps-experiment-audio-status${active && audioStatus === 'playing' ? ' is-playing' : ''}`} role="status">{active ? audioStatusLabels[audioStatus] : 'Аудиотест завершён'} · звук сам по себе не подтверждает GPS</p>}
      {active && summary.fixCount === 0 && <p>Дождись первой координаты. Если дома GPS не находится, оставь телефон ближе к окну.</p>}
      <dl className="gps-experiment-metrics">
        <div><dt>Всего точек</dt><dd>{summary.fixCount}</dd></div>
        <div><dt>Свежих в фоне</dt><dd>{summary.freshHiddenFixes}</dd></div>
        <div><dt>Последняя получена</dt><dd>{time(summary.lastFix?.receivedAt)}</dd></div>
        <div><dt>Точность</dt><dd>{summary.lastFix?.accuracy === undefined ? '—' : `${Math.round(summary.lastFix.accuracy)} м`}</dd></div>
      </dl>
      <p className="gps-experiment-small">При блокировке тест сам не выключает GPS. После возвращения подожди 30 секунд и останови запись. Звонок и переключение приложения также считаются скрытием — проверяй их отдельным запуском.</p>
    </section>
    {run && <section className="gps-experiment-card">
      <h2>3. Результат</h2>
      <p className="gps-experiment-verdict">{summary.result === 'no-hidden-period' ? 'Скрытого периода пока нет' : summary.sustainedHiddenFixes > 0 ? 'Свежие GPS-точки сохранены после первой минуты скрытия' : summary.confirmedHiddenFixes > 0 ? 'Есть свежие GPS-точки, сохранённые в фоне' : 'Получение и сохранение свежих точек в фоне не подтверждено'}</p>
      <dl className="gps-experiment-details">
        <div><dt>Записей GPS подтверждено в фоне</dt><dd>{summary.hiddenStorageWrites}</dd></div>
        <div><dt>Свежих уникальных GPS получено и сохранено в фоне</dt><dd>{summary.confirmedHiddenFixes}</dd></div>
        <div><dt>Из них после первой минуты скрытия</dt><dd>{summary.sustainedHiddenFixes}</dd></div>
        <div><dt>Координат из скрытого периода доставлено позже</dt><dd>{summary.delayedFixes}</dd></div>
        <div><dt>Записей таймера страницы в фоне</dt><dd>{summary.pageHiddenWrites}</dd></div>
        <div><dt>Записей независимого потока в фоне</dt><dd>{summary.workerHiddenTicks}</dd></div>
        <div><dt>Время скрытия</dt><dd>{duration(summary.hiddenDurationMs)}</dd></div>
        <div><dt>Ошибок GPS</dt><dd>{summary.errors}</dd></div>
        {audioRun && <><div><dt>Событий аудио получено и сохранено в фоне</dt><dd>{summary.audioHiddenEvents}</dd></div><div><dt>Ошибок аудио</dt><dd>{summary.audioErrors}</dd></div></>}
      </dl>
      <p>Звук и контрольные записи не означают, что GPS продолжал получать координаты. Проверяем отдельно свежие точки после первой минуты скрытия и их сохранение до возвращения. На месте отсутствие новых точек может быть связано и с неподвижностью телефона.</p>
      {summary.intervals.map((interval, index) => <p key={`${index}-${interval.start}`} className="gps-experiment-interval">{time(interval.start)} → {time(interval.end)} · {duration(interval.end - interval.start)}{interval.open ? ' · возврат не зафиксирован' : ''}</p>)}
      {!active && !run.endedAt && <p className="gps-experiment-notice">Предыдущая запись прервалась без завершения. Сохранившиеся данные доступны в отчёте.</p>}
      <div className="gps-experiment-actions"><button className="gps-experiment-primary" disabled={active || !report} onClick={() => void share()}>Поделиться отчётом</button><button disabled={active || !report} onClick={downloadReport}>Скачать JSON</button></div>
      <button className="gps-experiment-copy" disabled={active} onClick={() => { void navigator.clipboard.writeText(summaryText).then(() => setMessage('Итог скопирован. Вставь его в наш чат.'), () => { downloadJson('kabanda-gps-summary.json', { summary: summaryText }) }) }}>Скопировать итог для чата</button>
      <p className="gps-experiment-small">Отчёт — один файл с координатами и точными временами. Он хранится на телефоне и отправляется только через выбранное тобой действие.</p>
    </section>}
    <details className="gps-experiment-card"><summary>Память телефона и прошлые тесты</summary>
      <p>Постоянное хранение: {persistent === null ? 'не проверено' : persistent ? 'разрешено' : 'не предоставлено'}. Разрешение не включает фоновый GPS.</p>
      <button disabled={active || !navigator.storage?.persist} onClick={() => void persist()}>Запросить постоянное хранение</button>
      <label>Сохранённый тест<select disabled={active || busy} value={run?.id ?? ''} onChange={event => { runId.current = event.target.value; setReport(null); void refresh() }}>
        {!runs.length && <option value="">Тестов пока нет</option>}
        {runs.map(item => <option key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleString('ru-RU')} · {modeLabels[item.mode]} · {item.displayMode}</option>)}
      </select></label>
      <a href={appPath('lab/legacy')}>Открыть старый тест и его отчёты</a>
    </details>
    <details className="gps-experiment-card"><summary>Журнал событий · {rows.length}</summary>
      <div className="gps-experiment-log">{[...rows].reverse().slice(0, 60).map(row => <div key={row.id}><time>{time(row.receivedAt)}</time><strong>{row.kind}</strong><span>{row.visibility}{row.source ? ` · ${row.source}` : ''}</span>{row.capturedAt !== undefined && <span>GPS: {time(row.capturedAt)} · записано: {time(row.committedAt)} · точность: {Math.round(row.accuracy ?? 0)} м</span>}{row.detail && <span>{row.detail}</span>}</div>)}</div>
    </details>
    <footer>GPS-эксперимент 3 · аудио · {__APP_VERSION__}</footer>
  </main>
}
