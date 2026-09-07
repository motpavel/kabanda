import { useEffect, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { appPath } from '../../lib/paths'
import { downloadJson } from './evidence'
import { getCapabilitySnapshot } from './capabilities'
import { experimentDb, summarizeExperiment, type ExperimentEvent, type ExperimentMode, type ExperimentRun } from './experiment-data'
import { createExperimentRecorder } from './experiment-runtime'
import './gps-experiment.css'

const modeLabels: Record<ExperimentMode, string> = {
  watch: 'A · Наблюдение за GPS', poll: 'B · Запрос каждые 10 секунд', combined: 'C · Оба способа вместе',
}
const time = (value?: number) => value === undefined ? '—' : new Date(value).toLocaleTimeString('ru-RU', { hour12: false })
const duration = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1_000) % 60).padStart(2, '0')}`

export function GpsExperimentPage() {
  const [mode, setMode] = useState<ExperimentMode>('watch')
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
          schemaVersion: 2, exportedAt: new Date().toISOString(), run: selected,
          interrupted: !selected.endedAt, capabilities: getCapabilitySnapshot(),
          summary: summarizeExperiment(events, selected.endedAt ?? Date.now()), events,
          clockNotes: 'receivedAt: callback receipt; capturedAt: device GPS timestamp; committedAt: after IndexedDB write completion. All epoch milliseconds. Worker visibility is inferred only from page lifecycle intervals.',
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
    try {
      const next: ExperimentRun = {
        id: crypto.randomUUID(), startedAt: Date.now(), mode, keepScreen,
        displayMode: getCapabilitySnapshot().displayMode, userAgent: navigator.userAgent,
        version: __APP_VERSION__, persisted: await navigator.storage?.persisted?.() ?? null,
      }
      await experimentDb.runs.add(next)
      runId.current = next.id
      setRun(next)
      setRows([])
      const recorder = createExperimentRecorder(next, () => {}, detail => { if (mounted.current) setError(detail) })
      runner.current = recorder
      recorder.start()
      setActive(recorder.active)
      setNow(Date.now())
      await refresh()
    } catch (startError) {
      await runner.current?.stop('start-error')
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
  const canLock = active && summary.fixCount > 0 && elapsed >= 30_000
  const phase = !active ? 'Готов к эксперименту' : hidden ? 'После разблокировки подожди 30 секунд' : canLock ? 'Теперь заблокируй телефон на 3 минуты' : 'Оставь экран открытым на 30 секунд'
  const summaryText = [
    `Кабанда GPS-тест ${run?.id ?? ''}`, `${run ? modeLabels[run.mode] : ''} · ${run?.displayMode ?? ''}`,
    `Точек: ${summary.fixCount}, уникальных: ${summary.uniqueFixCount}`,
    `Свежих точек получено в фоне: ${summary.freshHiddenFixes}`,
    `GPS-записей подтверждено в фоне: ${summary.hiddenStorageWrites}`,
    `Пришли после открытия, время координаты из скрытого периода: ${summary.delayedFixes}`,
    `Таймер страницы / worker в фоне: ${summary.pageHiddenTicks} / ${summary.workerHiddenTicks}`,
    `Скрыто: ${duration(summary.hiddenDurationMs)}, ошибок GPS: ${summary.errors}`,
    ...summary.intervals.map(interval => `${time(interval.start)} → ${time(interval.end)}${interval.open ? ' (нет события возврата)' : ''}`),
    'Тест на месте. Отсутствие фоновых точек не доказывает невозможность записи при движении.',
  ].join('\n')

  return <main className="gps-experiment">
    <header className="gps-experiment-header">
      <a href={appPath('app')} aria-label="Вернуться в Кабанду" onClick={event => { if (active) { event.preventDefault(); setMessage('Сначала остановите тест, чтобы сохранить полный отчёт.') } }}>← Кабанда</a>
      <span>ЛАБОРАТОРИЯ / V2</span>
    </header>
    <div className="gps-experiment-intro"><h1>Что происходит<br />с GPS в фоне</h1><p>Один телефон. Три способа записи. Можно проверить дома.</p></div>
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
      <p>{mode === 'watch' ? 'Подписка остаётся включённой при блокировке. Временная ошибка GPS не завершает тест.' : mode === 'poll' ? 'Пробуем запрашивать свежую координату каждые 10 секунд. Браузер может задерживать запросы в фоне.' : 'Подписка и отдельные запросы работают вместе. Повторные координаты считаются отдельно.'}</p>
      <label className="gps-experiment-check"><input type="checkbox" checked={keepScreen} disabled={active || busy} onChange={event => setKeepScreen(event.target.checked)} />Не гасить открытый экран автоматически</label>
      <p className="gps-experiment-small">Боковая кнопка всё равно блокирует телефон. Каждый тест хранится отдельно. Ограничение — 15 минут; после заморозки остановка сработает при возобновлении.</p>
      <button className={active ? 'gps-experiment-stop' : 'gps-experiment-primary'} disabled={!ready || busy} onClick={() => void (active ? stop() : start())}>{busy ? 'Сохраняем…' : active ? 'Остановить и сохранить результат' : 'Начать новый тест'}</button>
    </section>
    <section className="gps-experiment-card gps-experiment-live">
      <div className="gps-experiment-live-heading"><h2>{active ? '2. Тест идёт' : '2. Наблюдение'}</h2><strong>{duration(elapsed)}</strong></div>
      <p className="gps-experiment-phase" role="status">{phase}</p>
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
      <p className="gps-experiment-verdict">{summary.result === 'no-hidden-period' ? 'Скрытого периода пока нет' : summary.result === 'hidden-fixes-observed' ? 'Есть свежие GPS-точки, полученные в фоне' : 'Получение свежих точек в фоне не подтверждено'}</p>
      <dl className="gps-experiment-details">
        <div><dt>Записей GPS подтверждено в фоне</dt><dd>{summary.hiddenStorageWrites}</dd></div>
        <div><dt>Координат из скрытого периода доставлено позже</dt><dd>{summary.delayedFixes}</dd></div>
        <div><dt>Таймер страницы в фоне</dt><dd>{summary.pageHiddenTicks}</dd></div>
        <div><dt>Записей независимого потока в фоне</dt><dd>{summary.workerHiddenTicks}</dd></div>
        <div><dt>Время скрытия</dt><dd>{duration(summary.hiddenDurationMs)}</dd></div>
        <div><dt>Ошибок GPS</dt><dd>{summary.errors}</dd></div>
      </dl>
      <p>Контрольные записи проверяют выполнение кода и работу памяти. Они не означают, что GPS продолжал получать координаты. На месте отсутствие новых точек может быть связано и с неподвижностью телефона.</p>
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
        {runs.map(item => <option key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleString('ru-RU')} · {item.mode} · {item.displayMode}</option>)}
      </select></label>
      <a href={appPath('lab/legacy')}>Открыть старый тест и его отчёты</a>
    </details>
    <details className="gps-experiment-card"><summary>Журнал событий · {rows.length}</summary>
      <div className="gps-experiment-log">{[...rows].reverse().slice(0, 60).map(row => <div key={row.id}><time>{time(row.receivedAt)}</time><strong>{row.kind}</strong><span>{row.visibility}{row.source ? ` · ${row.source}` : ''}</span>{row.capturedAt !== undefined && <span>GPS: {time(row.capturedAt)} · записано: {time(row.committedAt)} · точность: {Math.round(row.accuracy ?? 0)} м</span>}{row.detail && <span>{row.detail}</span>}</div>)}</div>
    </details>
    <footer>GPS-эксперимент 2 · {__APP_VERSION__}</footer>
  </main>
}
