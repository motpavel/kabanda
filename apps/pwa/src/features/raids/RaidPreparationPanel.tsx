import { useVisibleRead } from './read-refresh'
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../lib/http'
import { getRaidPresence, prepareRaid, sendParticipantCommand, sendRaidCommand, setManualRaidPresence, type PrepareRaidInput } from './api'
import { collectLocalReadiness, currentCoordinate, locationRecoveryMessage, type LocalReadinessResult } from './platform'
import { canCheckLocationAutomatically, canStartPreparedRaid } from './preparation'
import { buildReadinessRows } from './state'
import type { RaidPresenceRoster, RaidProjection } from './types'

type PreparationAction = 'start' | 'accept' | 'decline' | 'assign-navigator' | 'prepare' | 'cancel'

type Props = {
  raid: RaidProjection
  identityId: string
  stale: boolean
  onApplyRaid: (raid: RaidProjection) => Promise<void>
  onRefresh: () => Promise<void>
  onShare: () => Promise<void>
}

export function RaidPreparationPanel(props: Props) {
  const { raid, identityId, stale } = props
  const organizer = raid.organizerUserId === identityId
  const navigatorId = raid.navigatorUserId
  const isNavigator = navigatorId === identityId
  const me = raid.participants.find(p => p.id === identityId)
  const participating = me?.state === 'accepted' || me?.state === 'ready'
  const [roster, setRoster] = useState<RaidPresenceRoster | null>(null)
  const [facts, setFacts] = useState<LocalReadinessResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [needsPermission, setNeedsPermission] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [online, setOnline] = useState(navigator.onLine)
  const latest = useRef(props)
  latest.current = props
  const preparing = useRef(false)
  const hasLocationAccess = useRef(false)
  const acting = useRef(false)
  const mounted = useRef(true)
  const controller = useRef<AbortController | null>(null)
  const pendingPrepare = useRef<{ input: PrepareRaidInput; key: string } | null>(null)
  // Keep the exact input and operation key after an uncertain network response.
  const pendingAction = useRef<{ name: PreparationAction; version: number; key: string; navigatorId?: string } | null>(null)
  const checkRef = useRef<(explicit?: boolean) => Promise<void>>(async () => {})

  const apply = async (next: RaidProjection) => {
    if (mounted.current) await latest.current.onApplyRaid(next)
  }
  const reportError = async (reason: unknown) => {
    if (!mounted.current) return
    if (reason instanceof ApiError && reason.status === 409) {
      await latest.current.onRefresh()
    }
    setError(reason instanceof ApiError ? reason.message : 'Нет ответа от сервера. Повторим подготовку после восстановления связи.')
  }

  const check = async (explicit = false) => {
    const current = latest.current
    if (preparing.current || acting.current || current.stale || !navigator.onLine || document.visibilityState !== 'visible') return
    const member = current.raid.participants.find(p => p.id === identityId)
    if (current.raid.state !== 'lobby' || !['accepted', 'ready'].includes(member?.state ?? '')) return
    preparing.current = true
    const abort = new AbortController()
    controller.current = abort
    try {
      if (!pendingPrepare.current) {
        if (!explicit) {
          let permission: PermissionState | undefined
          try { permission = (await navigator.permissions?.query({ name: 'geolocation' }))?.state } catch { /* user action required */ }
          if (!canCheckLocationAutomatically(permission, hasLocationAccess.current)) {
            setNeedsPermission(true)
            if (permission === 'denied') setError('Доступ к геопозиции выключен. Разрешите его в настройках телефона или браузера и повторите проверку.')
            return
          }
        }
        setNeedsPermission(false)
        setChecking(true)
        let presence: PrepareRaidInput['presence']
        const capture = (position: GeolocationPosition) => {
          presence = { latitude: position.coords.latitude, longitude: position.coords.longitude, capturedAt: new Date(position.timestamp).toISOString(), accuracyMeters: position.coords.accuracy }
        }
        const nav = current.raid.navigatorUserId === identityId
        const measured = nav
          ? await collectLocalReadiness(identityId, abort.signal, capture, 50)
          : await currentCoordinate(abort.signal, capture, 50)
        if (abort.signal.aborted || !mounted.current) return
        if (nav) setFacts(measured as LocalReadinessResult)
        if (measured.locationIssue === 'denied') hasLocationAccess.current = false
        if (measured.locationIssue || !presence) {
          setError(measured.locationIssue === 'inaccurate' ? 'Для сбора команды нужна точность GPS до 50 м. Выйдите на открытое место — проверим снова.' : locationRecoveryMessage(measured.locationIssue ?? 'unavailable').replaceAll('Обновить геолокацию', 'Повторить проверку'))
          return
        }
        hasLocationAccess.current = true
        const fresh = latest.current.raid
        if (fresh.state !== 'lobby' || fresh.navigatorUserId !== current.raid.navigatorUserId) return
        const { locationIssue: _issue, ...readiness } = measured as LocalReadinessResult
        pendingPrepare.current = {
          key: crypto.randomUUID(),
          input: { expectedVersion: fresh.version, presence, ...(nav ? { readiness } : {}) },
        }
      }
      const pending = pendingPrepare.current
      const result = await prepareRaid(current.raid.id, pending.input, pending.key)
      pendingPrepare.current = null
      if (abort.signal.aborted || !mounted.current) return
      setRoster((previous) => previous && previous.serverAt > result.presence.serverAt ? previous : result.presence)
      setError(result.raid.navigatorUserId === identityId && result.raid.navigatorBlockers.length ? 'Телефон пока не готов к записи. Откройте «Проверка телефона»: там указана причина.' : null)
      await apply(result.raid)
    } catch (reason) {
      if (reason instanceof ApiError && reason.status < 500) pendingPrepare.current = null
      if (!abort.signal.aborted) await reportError(reason)
    } finally {
      preparing.current = false
      if (mounted.current) setChecking(false)
      // A role change/StrictMode cleanup may cancel an in-flight check. Resume
      // immediately instead of making the new screen wait for the 12s timer.
      if (abort.signal.aborted && mounted.current && !acting.current) {
        window.setTimeout(() => { if (mounted.current) void checkRef.current() }, 0)
      }
    }
  }
  checkRef.current = check

  useEffect(() => {
    mounted.current = true
    const tick = () => { setNow(Date.now()); setOnline(navigator.onLine) }
    const timer = window.setInterval(tick, 2_000)
    return () => { mounted.current = false; controller.current?.abort(); window.clearInterval(timer) }
  }, [])

  const refreshRoster = useVisibleRead(async () => {
    if (!navigator.onLine || document.visibilityState !== 'visible') return
    try {
      const next = await getRaidPresence(raid.id)
      if (mounted.current && latest.current.raid.id === raid.id && latest.current.raid.state === 'lobby') setRoster((previous) => previous && previous.serverAt > next.serverAt ? previous : next)
    } catch { /* keep the last result until its existing freshness deadline */ }
  }, `${identityId}:${raid.id}:presence`, raid.state === 'lobby' && participating && !stale, 5_000)

  useEffect(() => {
    setRoster(null)
    setFacts(null)
    pendingPrepare.current = null
    controller.current?.abort()
    if (raid.state !== 'lobby' || !participating || stale) return
    const resume = () => { setOnline(navigator.onLine); void checkRef.current() }
    void checkRef.current()
    const checkTimer = window.setInterval(() => void checkRef.current(), 12_000)
    window.addEventListener('online', resume)
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      controller.current?.abort()
      window.clearInterval(checkTimer)
      window.removeEventListener('online', resume); window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [raid.id, raid.state, navigatorId, participating, stale])

  const action = async (name: PreparationAction, selectedNavigator?: string) => {
    if (acting.current || stale || !navigator.onLine) return
    acting.current = true
    setBusy(true)
    setError(null)
    // Stop local preparation so it cannot race with a deliberate action.
    controller.current?.abort()
    const previous = pendingAction.current
    if (previous && (previous.name !== name || previous.navigatorId !== selectedNavigator)) {
      setError('Предыдущее действие ещё не подтверждено. Повторите его или обновите данные.')
      acting.current = false; setBusy(false); return
    }
    const pending = previous ?? { name, version: latest.current.raid.version, key: crypto.randomUUID(), ...(selectedNavigator ? { navigatorId: selectedNavigator } : {}) }
    pendingAction.current = pending
    try {
      const next = name === 'prepare'
        ? (await prepareRaid(raid.id, { expectedVersion: pending.version }, pending.key)).raid
        : name === 'accept' || name === 'decline'
          ? await sendParticipantCommand(raid.id, name, pending.version, pending.key)
          : await sendRaidCommand(raid.id, name, pending.version, pending.key, selectedNavigator ? { navigatorUserId: selectedNavigator } : undefined)
      pendingAction.current = null
      await apply(next)
      if (next.state === 'lobby') void refreshRoster().catch(() => undefined)
    } catch (reason) {
      if (reason instanceof ApiError && reason.status < 500) pendingAction.current = null
      await reportError(reason)
    } finally {
      acting.current = false
      if (mounted.current) setBusy(false)
    }
  }

  useEffect(() => {
    if (!busy && participating && raid.state === 'lobby') void checkRef.current()
  }, [busy, participating, raid.state])

  useEffect(() => {
    if (organizer && !stale && online && (raid.state === 'draft' || (raid.state === 'lobby' && !navigatorId))) void action('prepare')
  }, [raid.id, raid.state, navigatorId, organizer, stale, online])

  const nav = raid.participants.find(p => p.id === navigatorId)
  const canStart = canStartPreparedRaid(raid, identityId, roster, online, stale, now)
  const waiters = roster?.participants.filter(p => p.status === 'waiting') ?? []
  const rows = facts ? buildReadinessRows(facts) : []
  const myPresence = roster?.participants.find(p => p.id === identityId)?.status
  const needsLocation = needsPermission && participating && raid.state === 'lobby'

  return <section className="raid-preparation" aria-label="Подготовка к рейду">
    {organizer && raid.state === 'lobby' ? <details className="raid-preparation__details raid-navigator-details">
      <summary><span><small>Запись маршрута</small><strong>{isNavigator ? 'Ваш телефон' : nav?.displayName ?? 'Выбираем навигатора…'}</strong></span><span className="raid-disclosure-action">Изменить</span></summary>
      <div className="raid-disclosure-content">
        <label htmlFor="preparation-navigator">Кто будет навигатором?</label>
        <select id="preparation-navigator" value={navigatorId ?? ''} disabled={busy || stale || !online} onChange={e => void action('assign-navigator', e.target.value)}>
          {!navigatorId && <option value="">Выберите участника</option>}
          {raid.participants.filter(p => p.state === 'accepted' || p.state === 'ready').map(p => <option value={p.id} key={p.id}>{p.displayName}{p.id === identityId ? ' · вы' : ''}</option>)}
        </select>
        <p className="raid-field-hint">Этот телефон будет записывать общий маршрут.</p>
      </div>
    </details> : <div className="kb-card raid-preparation__summary"><div><small>Запись маршрута</small><strong>{isNavigator ? 'Ваш телефон' : nav?.displayName ?? 'Выбираем навигатора…'}</strong></div></div>}
    <div className="kb-card">
      <div className="kb-section-head"><h2>Кто едет</h2>{raid.state === 'lobby' && <button type="button" onClick={() => void props.onShare()}>Пригласить</button>}</div>
      <ul className="raid-presence-list">{raid.participants.filter(p => p.state !== 'declined' && p.state !== 'removed').map(p => {
        const present = roster?.participants.find(item => item.id === p.id)
        return <li key={p.id}>
          <span className="raid-avatar" aria-hidden="true">{p.displayName.slice(0, 1)}</span>
          <span><strong>{p.displayName}{p.id === identityId ? ' · вы' : ''}</strong><small>{p.state === 'invited' ? 'Ещё не ответил' : present?.status === 'manual' ? 'На месте · подтверждено' : present?.status === 'nearby' ? 'На месте' : 'Едет · ждём геолокацию'}</small></span>
          {organizer && p.id !== identityId && (present?.status === 'waiting' || present?.status === 'manual') && <button type="button" disabled={busy || stale || !online} onClick={async () => { if (acting.current) return; acting.current = true; setBusy(true); try { setRoster(await setManualRaidPresence(raid.id, p.id, present.status !== 'manual')) } catch (e) { await reportError(e) } finally { acting.current = false; setBusy(false) } }}>{present.status === 'manual' ? 'Отменить отметку' : 'Он здесь'}</button>}
        </li>
      })}</ul>
    </div>
    {participating && raid.state === 'lobby' && <div className="raid-preparation__status" data-ready={canStart} role="status" aria-live="polite">
      <p>{myPresence === 'nearby' || myPresence === 'manual' ? '✓ Вы на месте' : checking ? 'Определяем геопозицию…' : 'Определяем место встречи'}</p>
      {isNavigator && <p>{raid.navigatorReady ? '✓ Телефон готов к записи' : facts && !facts.indexedDbWritable ? 'Не удаётся сохранить маршрут на телефоне' : 'Проверяем готовность телефона'}</p>}
      {!isNavigator && nav && <p>{raid.navigatorReady ? `✓ Телефон ${nav.displayName} готов` : `Ждём готовность телефона ${nav.displayName}`}</p>}
      {canStart && <p>Всё готово. Можно ехать.</p>}
    </div>}
    {!online && <p className="kb-notice" role="status">Нет связи. Подготовка продолжится после подключения. Рейд сам не начнётся.</p>}
    {stale && <button type="button" onClick={() => void props.onRefresh()}>Обновить данные</button>}
    {error && <p className="kb-error" role="alert">{error}</p>}
    {error && pendingAction.current && <button type="button" disabled={busy || stale || !online} onClick={() => { const pending = pendingAction.current; if (pending) void action(pending.name, pending.navigatorId) }}>Повторить действие</button>}

    {facts && <details className="raid-preparation__details"><summary><span>Проверка телефона<small>{checking ? 'Проверяем…' : rows.some(row => row.status === 'fail') ? 'Есть пункты, требующие внимания' : 'Геолокация, связь и запись маршрута'}</small></span></summary><ul className="raid-phone-checks">{rows.map(row => <li key={row.id}><span className={`raid-check-icon raid-check-icon--${row.status}`} aria-label={{ pass: 'Готово', warn: 'Обратите внимание', fail: 'Ошибка', unknown: 'Не проверено' }[row.status]}>{{ pass: '✓', warn: '!', fail: '!', unknown: '–' }[row.status]}</span><span><strong>{row.label}</strong><small>{row.detail}</small></span></li>)}</ul></details>}
    <p className="kb-muted">Во время записи держите Кабанду открытой на телефоне навигатора.</p>
    <div className="raid-preparation__action">
      {me?.state === 'invited' ? <><button className="kb-primary" disabled={busy || stale || !online} onClick={() => void action('accept')}>Еду</button><button type="button" disabled={busy || stale || !online} onClick={() => void action('decline')}>Не поеду</button></>
        : raid.state === 'planned' && organizer ? <button className="kb-primary" disabled={busy || stale || !online} onClick={() => void action('prepare')}>Открыть сбор</button>
        : needsLocation ? <button className="kb-primary" disabled={busy || checking || stale || !online} onClick={() => void check(true)}>{error ? 'Повторить проверку' : 'Разрешить геолокацию'}</button>
        : error && participating && !pendingAction.current ? <button className="kb-primary" disabled={busy || checking || stale || !online} onClick={() => void check(true)}>Повторить проверку</button>
        : organizer ? <button className="kb-primary" disabled={busy || (!canStart && pendingAction.current?.name !== 'start') || stale || !online} onClick={() => void action('start')}>{busy ? 'Подтверждаем…' : pendingAction.current?.name === 'start' ? 'Проверить старт' : canStart ? 'Поехали' : waiters.some(p => p.id !== identityId) ? 'Ждём участников' : 'Подготовка к старту…'}</button>
        : participating ? <p role="status">Вы едете. Рейд запустит организатор.</p> : null}
    </div>
    {organizer && <details className="raid-preparation__details"><summary>Управление рейдом</summary><button type="button" disabled={busy || stale || !online} onClick={() => { if (window.confirm('Отменить рейд для всей команды?')) void action('cancel') }}>Отменить рейд</button></details>}
  </section>
}
