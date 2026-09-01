import '@fontsource-variable/geist'
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { ApiError } from '../../lib/http'
import { appPath, appUrl } from '../../lib/paths'
import { getCurrentUser, loginWithPassword, requestMagicLink } from '../auth/api'
import { listKabandas } from '../kabandas/api'
import type { KabandaSummary } from '../kabandas/types'
import { getActiveIdentityId } from '../offline/ledger'
import {
  createRaid,
  reportReadiness,
  sendParticipantCommand,
  sendRaidCommand,
} from './api'
import {
  clearCreateRaidAttempt,
  localDateTimeInputToIso,
  matchesCreateRaidAttempt,
  normalizeCreateRaidPayload,
  persistCreateRaidAttempt,
  readCreateRaidAttempt,
  restoreCreateRaidForm,
  selectCreateRaidAttempt,
  type CreateRaidAttempt,
} from './createAttempt'
import { useRaidProjection } from './hooks'
import { collectLocalReadiness } from './platform'
import { findRaidCreationMembership } from './production-model'
import type { RaidRoute } from './routing'
import {
  raidDetailRemountKey,
  shouldRevalidateCachedRaidSession,
  shouldUseCachedRaidIdentity,
} from './session'
import {
  buildReadinessReport,
  buildReadinessRows,
  canShareRaidInvite,
  isReadinessReportCurrent,
  isStaleConflict,
  selectPrimaryAction,
} from './state'
import type {
  LocalReadinessFacts,
  RaidAllowedAction,
  RaidParticipant,
  RaidProjection,
  RaidReadinessSummary,
  ReadinessReportInput,
  ReadinessStatus,
} from './types'
import { ActiveRaidPanel } from './recording/ActiveRaidPanel'
import { FinalizationPanel } from '../results/FinalizationPanel'
import { ResultPanel } from '../results/ResultPanel'
import { leaveRaid } from '../results/api'
import './raids.css'

type RaidIdentity = { id: string }
type Session =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'unavailable' }
  | { status: 'ready'; identity: RaidIdentity; source: 'canonical' | 'cached' }

export function RaidApp({ route }: { route: Exclude<RaidRoute, { kind: 'home' }> }) {
  const [session, setSession] = useState<Session>({ status: 'loading' })
  useEffect(() => {
    let active = true
    getCurrentUser()
      .then((user) => active && setSession({ status: 'ready', identity: { id: user.id }, source: 'canonical' }))
      .catch(async (error: unknown) => {
        if (!active) return
        if (!shouldUseCachedRaidIdentity(error)) {
          setSession({ status: 'anonymous' })
          return
        }
        let identityId: string | null = null
        try {
          identityId = await getActiveIdentityId()
        } catch {
          // An unavailable identity store cannot safely expose another user's cache.
        }
        if (!active) return
        setSession(identityId
          ? { status: 'ready', identity: { id: identityId }, source: 'cached' }
          : { status: 'unavailable' })
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (session.status !== 'ready' || session.source !== 'cached') return
    let active = true
    let inFlight = false
    const revalidate = async () => {
      if (
        inFlight ||
        !shouldRevalidateCachedRaidSession(
          session.source,
          navigator.onLine,
          document.visibilityState,
        )
      ) return
      inFlight = true
      try {
        const user = await getCurrentUser()
        if (active) setSession({ status: 'ready', identity: { id: user.id }, source: 'canonical' })
      } catch (error) {
        if (active && !shouldUseCachedRaidIdentity(error)) setSession({ status: 'anonymous' })
      } finally {
        inFlight = false
      }
    }
    const revalidateIfVisible = () => void revalidate()
    window.addEventListener('online', revalidateIfVisible)
    window.addEventListener('focus', revalidateIfVisible)
    document.addEventListener('visibilitychange', revalidateIfVisible)
    return () => {
      active = false
      window.removeEventListener('online', revalidateIfVisible)
      window.removeEventListener('focus', revalidateIfVisible)
      document.removeEventListener('visibilitychange', revalidateIfVisible)
    }
  }, [session])

  if (session.status === 'loading') return <RaidShell><p aria-busy="true">Загружаем рейд…</p></RaidShell>
  if (session.status === 'anonymous') return <RaidSignIn />
  if (session.status === 'unavailable') return <RaidShell><EmptyState title="Не удалось проверить вход" detail="Соединение недоступно, а сохранённой identity на этом устройстве нет. Попробуйте ещё раз онлайн." /></RaidShell>
  if (route.kind === 'invalid') return <RaidShell><EmptyState title="Ссылка на рейд некорректна" detail="Откройте рейд с главной страницы КАБАНДЫ." /></RaidShell>
  if (session.source === 'cached' && route.kind !== 'raid') return <RaidShell><EmptyState title="Доступна только сохранённая копия" detail="Создание рейда требует подтверждённой онлайн-сессии." /></RaidShell>
  if (route.kind === 'create') return <CreateRaidPage identityId={session.identity.id} kabandaId={route.kabandaId} />
  return <RaidDetailPage
    key={raidDetailRemountKey(session.identity.id, route.raidId)}
    user={session.identity}
    raidId={route.raidId}
    staleOnly={session.source === 'cached'}
  />
}

function RaidSignIn() {
  const [mode, setMode] = useState<'password' | 'email'>('password')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (status === 'sending') return
    setStatus('sending')
    try {
      if (mode === 'password') {
        await loginWithPassword(username, password)
        window.location.reload()
      } else {
        await requestMagicLink(email, `${window.location.pathname}${window.location.search}`)
        setStatus('sent')
      }
    } catch {
      setStatus('error')
    }
  }
  return (
    <RaidShell>
      <section className="kb-card raid-auth">
        <p className="kb-kicker">Продолжим с того же места</p>
        <h1>Войдите в КАБАНДУ</h1>
        <p className="kb-muted">Войдите по логину и паролю. Ссылка на рейд указывает место, но сама по себе не даёт доступ.</p>
        {status === 'sent' ? <p className="kb-notice">Ссылка отправлена. Откройте письмо на этом устройстве.</p> : (
          <form onSubmit={submit}>
            {mode === 'password' ? <><label htmlFor="raid-username">Логин</label><input id="raid-username" autoComplete="username" required minLength={3} maxLength={32} value={username} onChange={(event) => setUsername(event.target.value)} /><label htmlFor="raid-password">Пароль</label><input id="raid-password" type="password" autoComplete="current-password" required minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></> : <><label htmlFor="raid-email">Электронная почта</label><input id="raid-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></>}
            <button className="kb-primary raid-primary" type="submit" disabled={status === 'sending'}>{status === 'sending' ? 'Входим…' : mode === 'password' ? 'Войти' : 'Получить ссылку'}</button>
          </form>
        )}
        {status === 'error' && <p className="kb-error" role="alert">Не удалось войти. Проверьте данные.</p>}
        {status !== 'sent' && <button className="kb-text-action" type="button" onClick={() => { setMode((value) => value === 'password' ? 'email' : 'password'); setStatus('idle') }}>{mode === 'password' ? 'Войти через почту' : 'Войти по логину и паролю'}</button>}
      </section>
    </RaidShell>
  )
}

function CreateRaidPage({ identityId, kabandaId }: { identityId: string; kabandaId: string }) {
  const [kabanda, setKabanda] = useState<KabandaSummary | null>(null)
  const [title, setTitle] = useState(defaultRaidTitle)
  const [startMode, setStartMode] = useState<'now' | 'later'>('now')
  const [startsAt, setStartsAt] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading')
  const fallbackAttempt = useRef<CreateRaidAttempt | null>(null)

  useEffect(() => {
    fallbackAttempt.current = null
    setTitle(defaultRaidTitle())
    setDescription('')
    setStartMode('now')
    setStartsAt('')
    const attempt = readCreateRaidAttempt(identityId)
    const restored = restoreCreateRaidForm(attempt, identityId, kabandaId)
    if (!attempt || !restored) return
    fallbackAttempt.current = attempt
    setTitle(restored.title)
    setDescription(restored.description)
    setStartMode(restored.startMode)
    setStartsAt(restored.startsAt)
  }, [identityId, kabandaId])

  useEffect(() => {
    let active = true
    setKabanda(null)
    setStatus('loading')
    listKabandas()
      .then((kabandas) => {
        if (!active) return
        const selected = findRaidCreationMembership(kabandas, kabandaId)
        if (!selected) throw new Error('Active Kabanda membership required')
        setKabanda(selected)
        setStatus('ready')
      })
      .catch(() => active && setStatus('error'))
    return () => {
      active = false
    }
  }, [identityId, kabandaId])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!kabanda || status === 'saving') return
    setStatus('saving')
    try {
      const scheduledAt = startMode === 'now' ? null : localDateTimeInputToIso(startsAt)
      if (startMode === 'later' && !scheduledAt) throw new Error('Invalid scheduled time')
      const input = {
        title: title.trim(),
        description: description.trim() || null,
        scheduledAt,
      }
      const normalizedPayload = normalizeCreateRaidPayload(input)
      const previous = readCreateRaidAttempt(identityId) ?? fallbackAttempt.current
      if (
        scheduledAt &&
        Date.parse(scheduledAt) <= Date.now() &&
        !matchesCreateRaidAttempt(previous, identityId, kabanda.id, normalizedPayload)
      ) throw new Error('Scheduled time must be in the future')
      const attempt = selectCreateRaidAttempt(
        previous,
        identityId,
        kabanda.id,
        normalizedPayload,
        crypto.randomUUID(),
      )
      fallbackAttempt.current = attempt
      persistCreateRaidAttempt(identityId, attempt)
      const raid = await createRaid(
        kabanda.id,
        input,
        attempt.key,
      )
      clearCreateRaidAttempt(identityId, attempt)
      fallbackAttempt.current = null
      window.location.assign(`${appPath('app')}?raid=${encodeURIComponent(raid.id)}`)
    } catch {
      setStatus('error')
    }
  }

  return (
    <RaidShell>
      <a className="raid-back" href={`${appPath('app')}?kabanda=${encodeURIComponent(kabandaId)}&tab=raids`}>← Назад к рейдам</a>
      <header className="raid-page-head"><p className="kb-kicker">Меньше минуты</p><h1>Новый рейд</h1><p>Название, время и люди. Остальное решите в lobby.</p></header>
      {status === 'loading' && <p aria-busy="true">Загружаем Кабанду…</p>}
      {status === 'error' && <p className="kb-error" role="alert">Не удалось открыть форму или сохранить рейд. Проверьте будущее время, доступ и соединение.</p>}
      {kabanda && (
        <form className="raid-create-form" onSubmit={submit}>
          <section className="kb-card">
            <p className="kb-kicker">{kabanda.avatar} {kabanda.name}</p>
            <label htmlFor="raid-title">Название</label>
            <input id="raid-title" required maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} />
            <fieldset className="raid-segmented"><legend>Когда</legend><button type="button" aria-pressed={startMode === 'now'} onClick={() => setStartMode('now')}>Стартуем сегодня</button><button type="button" aria-pressed={startMode === 'later'} onClick={() => setStartMode('later')}>Запланировать</button></fieldset>
            {startMode === 'later' && <><label htmlFor="raid-time">Дата и время</label><input id="raid-time" type="datetime-local" step="0.001" required value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></>}
            <label htmlFor="raid-description">Короткая заметка <span className="raid-optional">необязательно</span></label>
            <textarea id="raid-description" maxLength={500} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Что взять или где встречаемся" />
            <p className="kb-muted raid-form-note">После создания откройте lobby — сервер пригласит текущий состав Кабанды одним snapshot.</p>
          </section>
          <button className="kb-primary raid-primary raid-sticky" type="submit" disabled={status === 'saving' || !title.trim() || (startMode === 'later' && !startsAt)}>{status === 'saving' ? 'Создаём…' : startMode === 'later' ? 'Запланировать рейд' : 'Создать рейд'}</button>
        </form>
      )}
    </RaidShell>
  )
}

function RaidDetailPage({
  user,
  raidId,
  staleOnly,
}: {
  user: RaidIdentity
  raidId: string
  staleOnly: boolean
}) {
  const resource = useRaidProjection(user.id, raidId, staleOnly)
  const [operation, setOperation] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [localFacts, setLocalFacts] = useState<LocalReadinessFacts | null>(null)
  const [lastReport, setLastReport] = useState<{
    raidId: string
    report: RaidReadinessSummary
  } | null>(null)
  const [navigatorId, setNavigatorId] = useState('')
  const [handoffNavigatorId, setHandoffNavigatorId] = useState('')
  const operationKeys = useRef(new Map<string, string>())
  const pendingReadiness = useRef<{
    key: string
    input: ReadinessReportInput
    facts: LocalReadinessFacts
  } | null>(null)

  if (resource.loading && !resource.raid) return <RaidShell><p aria-busy="true">Собираем lobby…</p></RaidShell>
  if (!resource.raid) return <RaidShell><EmptyState title="Рейд не открылся" detail={resource.error ?? 'Попробуйте вернуться на главную.'} /></RaidShell>

  const raid = resource.raid
  const allowed = new Set(raid.allowedActions)
  const navigatorParticipant = raid.participants.find(({ id }) => id === raid.navigatorUserId) ?? null
  const viewerParticipant = raid.participants.find(({ id }) => id === user.id) ?? null
  const viewerIsNavigator = raid.navigatorUserId === user.id
  const readinessAccepted = raid.navigatorReady || (
    lastReport?.raidId === raid.id &&
    isReadinessReportCurrent(lastReport.report, raid.version)
  )
  const primary = selectPrimaryAction(raid, {
    surface: 'raid',
    online: navigator.onLine,
    stale: resource.stale,
    viewerIsNavigator,
    viewerParticipantState: viewerParticipant?.state ?? null,
    localReadinessReported: readinessAccepted,
  })

  const keyFor = (name: string) => {
    const logical = `${name}:${raid.version}`
    let key = operationKeys.current.get(logical)
    if (!key) {
      key = crypto.randomUUID()
      operationKeys.current.set(logical, key)
    }
    return { logical, key }
  }

  const applyCommand = async (
    command: Exclude<RaidAllowedAction, 'finish' | 'leave' | 'settle-finalization'>,
    extra?: { navigatorUserId: string },
  ) => {
    if (resource.stale || operation || !navigator.onLine) return
    const { logical, key } = keyFor(extra ? `${command}:${extra.navigatorUserId}` : command)
    setOperation(command)
    setMessage(null)
    try {
      const next = command === 'accept' || command === 'decline' || command === 'ready'
        ? await sendParticipantCommand(raid.id, command, raid.version, key)
        : await sendRaidCommand(raid.id, command, raid.version, key, extra)
      operationKeys.current.delete(logical)
      await resource.applyRaid(next)
    } catch (error) {
      if (error instanceof ApiError && isStaleConflict(error.status, error.code)) {
        operationKeys.current.delete(logical)
        setMessage('Рейд уже изменился в другой вкладке. Обновили каноническое состояние.')
        await resource.refresh()
      } else if (error instanceof ApiError) {
        setMessage(error.message)
        if (error.status === 409 && error.code !== 'IDEMPOTENCY_CONFLICT') {
          operationKeys.current.delete(logical)
          await resource.refresh()
        }
      } else {
        setMessage('Команда не подтверждена сервером. Повтор сохранит тот же ключ действия.')
      }
    } finally {
      setOperation(null)
    }
  }

  const leaveCurrentRaid = async () => {
    if (resource.stale || operation || !navigator.onLine || !allowed.has('leave')) return
    if (!window.confirm('Выйти из активного рейда? Новый вклад после выхода не начисляется.')) return
    const { logical, key } = keyFor('leave')
    setOperation('leave')
    setMessage(null)
    try {
      const next = await leaveRaid(raid.id, raid.version, key)
      operationKeys.current.delete(logical)
      await resource.applyRaid(next)
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Выход не подтверждён. Повтор использует тот же ключ.')
    } finally {
      setOperation(null)
    }
  }

  const runReadiness = async () => {
    if (
      !viewerIsNavigator ||
      viewerParticipant?.state !== 'ready' ||
      resource.stale ||
      operation ||
      !navigator.onLine
    ) return
    setOperation('readiness')
    setMessage(null)
    try {
      let pending = pendingReadiness.current
      if (!pending || pending.input.expectedVersion !== raid.version) {
        const facts = await collectLocalReadiness(user.id)
        pending = {
          key: crypto.randomUUID(),
          input: buildReadinessReport(raid.version, facts),
          facts,
        }
        pendingReadiness.current = pending
      }
      setLocalFacts(pending.facts)
      const response = await reportReadiness(
        raid.id,
        pending.input,
        pending.key,
      )
      pendingReadiness.current = null
      setLastReport({ raidId: raid.id, report: response.report })
      await resource.applyRaid(response.raid)
      if (response.report.blockers.length) setMessage('Сервер подтвердил блокеры. Исправьте их и отправьте новый отчёт.')
    } catch (error) {
      if (error instanceof ApiError && isStaleConflict(error.status, error.code)) {
        pendingReadiness.current = null
        await resource.refresh()
      } else if (error instanceof ApiError && error.status < 500) {
        pendingReadiness.current = null
      }
      setMessage(
        error instanceof ApiError
          ? error.message
          : 'Проверка не подтверждена сервером. Зелёный старт не показываем.',
      )
    } finally {
      setOperation(null)
    }
  }

  const handlePrimary = async () => {
    if (!primary) return
    if (primary.kind === 'refresh') return resource.refresh()
    if (primary.kind === 'readiness') return runReadiness()
    if (primary.kind === 'navigate') return
    if (primary.command === 'start' && !window.confirm('Начать один канонический рейд сейчас?')) return
    await applyCommand(primary.command)
  }

  const share = async () => {
    const url = `${appUrl('app')}?raid=${encodeURIComponent(raid.id)}`
    const canShare = typeof navigator.share === 'function'
    try {
      if (canShare) await navigator.share({ title: raid.title, text: `Присоединяйтесь к рейду «${raid.title}»`, url })
      else await navigator.clipboard.writeText(url)
      setMessage(canShare ? null : 'Ссылка на lobby скопирована.')
    } catch {
      setMessage('Не удалось поделиться ссылкой. Попробуйте ещё раз.')
    }
  }

  const readinessRows = localFacts ? buildReadinessRows(localFacts) : []
  const navigatorCandidates = raid.participants.filter(({ state }) => state === 'accepted' || state === 'ready')
  const handoffCandidates = raid.participants.filter(
    ({ id, state }) => state === 'active' && id !== raid.navigatorUserId,
  )
  const readinessStatus: ReadinessStatus = raid.navigatorBlockers.length
    ? 'fail'
    : raid.navigatorReady
      ? raid.navigatorWarnings.length
        ? 'warn'
        : 'pass'
      : 'unknown'

  return (
    <RaidShell>
      <a className="raid-back" href={`${appPath('app')}?kabanda=${encodeURIComponent(raid.kabandaId)}&tab=raids`}>← К рейдам</a>
      <header className="raid-hero">
        <div><p className="kb-kicker">Рейд Кабанды</p><h1>{raid.title}</h1><p>{raid.scheduledAt ? new Date(raid.scheduledAt).toLocaleString('ru-RU') : 'Старт после готовности команды'}</p></div>
        <span className={`raid-state raid-state--${raid.state}`}>{stateLabel(raid.state)}</span>
      </header>

      {resource.stale && <p className="kb-stale" role="status">Read-only копия{resource.savedAt ? ` от ${new Date(resource.savedAt).toLocaleString('ru-RU')}` : ''}. Ни одна команда не будет поставлена в offline-очередь.</p>}
      {message && <p className="kb-notice" role="status">{message}</p>}
      {resource.error && <p className="kb-error" role="alert">{resource.error}</p>}

      <section className="raid-overview">
        <article className="kb-card raid-navigator">
          <p className="kb-kicker">Навигатор</p>
          <h2>{navigatorParticipant?.displayName ?? 'Ещё не выбран'}</h2>
          <p className="kb-muted">Только его устройство отправляет readiness. Фоновый GPS не считается подтверждённым.</p>
          {allowed.has('assign-navigator') && !resource.stale && (
            <div className="raid-assign"><label htmlFor="navigator">Выбрать из готовых</label><select id="navigator" value={navigatorId} onChange={(event) => setNavigatorId(event.target.value)}><option value="">Выберите участника</option>{navigatorCandidates.map((participant) => <option key={participant.id} value={participant.id}>{participant.displayName}</option>)}</select><button type="button" disabled={!navigatorId || operation === 'assign-navigator'} onClick={() => applyCommand('assign-navigator', { navigatorUserId: navigatorId })}>{operation === 'assign-navigator' ? 'Назначаем…' : 'Назначить'}</button></div>
          )}
        </article>
        <article className="kb-card raid-version"><p className="kb-kicker">Каноническое состояние</p><strong>v{raid.version}</strong><span>{navigator.onLine ? 'Сервер на связи' : 'Офлайн'}</span></article>
      </section>

      {(raid.state === 'draft' || raid.state === 'planned' || raid.state === 'lobby') && (
        <section className="kb-card">
          <div className="kb-section-head"><div><p className="kb-kicker">Lobby</p><h2>Кто едет</h2></div>{canShareRaidInvite(raid.state) && <button type="button" onClick={share}>Пригласить</button>}</div>
          <ParticipantList participants={raid.participants} navigatorId={raid.navigatorUserId} />
          {allowed.has('decline') && !resource.stale && <button className="kb-text-action raid-decline" type="button" disabled={operation === 'decline'} onClick={() => applyCommand('decline')}>Не смогу поехать</button>}
        </section>
      )}

      {(raid.state === 'draft' || raid.state === 'planned' || raid.state === 'lobby') && (viewerIsNavigator || raid.navigatorUserId) && (
        <section className="kb-card raid-readiness">
          <div className="kb-section-head"><div><p className="kb-kicker">Перед стартом</p><h2>Готов ли телефон?</h2></div><span className={`readiness-pill readiness-pill--${readinessStatus}`}>{readinessStatus}</span></div>
          <p className="kb-muted">Проверяем только измеримое. КАБАНДА не обещает запись при выключенном экране.</p>
          {readinessRows.length > 0 && <ul>{readinessRows.map((row) => <li key={row.id} data-status={row.status}><span aria-hidden="true">{statusIcon(row.status)}</span><div><strong>{row.label}</strong><small>{row.detail}</small></div></li>)}</ul>}
          {raid.navigatorBlockers.length ? <div className="kb-error"><strong>Сервер блокирует старт:</strong><ul>{raid.navigatorBlockers.map((blocker) => <li key={blocker}>{readinessCodeLabel(blocker)}</li>)}</ul></div> : null}
          {raid.navigatorWarnings.length ? <div className="kb-notice"><strong>Предупреждения:</strong><ul>{raid.navigatorWarnings.map((warning) => <li key={warning}>{readinessCodeLabel(warning)}</li>)}</ul></div> : null}
          {!viewerIsNavigator && <p className="kb-notice">Проверку должен отправить {navigatorParticipant?.displayName ?? 'выбранный навигатор'} со своего устройства.</p>}
        </section>
      )}

      {(raid.state === 'active' || raid.state === 'paused') && (
        <ActiveRaidPanel
          identityId={user.id}
          raid={raid}
          staleProjection={resource.stale}
          serverPrimary={primary}
          operationPending={Boolean(operation)}
          onServerPrimary={() => void handlePrimary()}
          onCanonicalRefresh={resource.refresh}
          onApplyRaid={resource.applyRaid}
        />
      )}

      {raid.state === 'finalizing' && (
        <FinalizationPanel
          identityId={user.id}
          raid={raid}
          staleProjection={resource.stale}
          onCanonicalRefresh={resource.refresh}
          onApplyRaid={resource.applyRaid}
        />
      )}

      {raid.state === 'completed' && <ResultPanel identityId={user.id} raid={raid} staleOnly={resource.stale} />}

      {allowed.has('handoff-navigator') && !resource.stale && handoffCandidates.length > 0 && (
        <section className="kb-card raid-handoff">
          <p className="kb-kicker">Передача навигации</p>
          <h2>Сменить устройство и навигатора</h2>
          <p className="kb-muted">
            После подтверждения старый lease закроется сразу. Его неприсланные точки уже не войдут в канонический маршрут.
          </p>
          <div className="raid-assign">
            <label htmlFor="handoff-navigator">Новый навигатор</label>
            <select
              id="handoff-navigator"
              value={handoffNavigatorId}
              onChange={(event) => setHandoffNavigatorId(event.target.value)}
            >
              <option value="">Выберите активного участника</option>
              {handoffCandidates.map((participant) => (
                <option key={participant.id} value={participant.id}>{participant.displayName}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={!handoffNavigatorId || operation === 'handoff-navigator'}
              onClick={() => window.confirm('Передать запись маршрута другому навигатору сейчас?') &&
                applyCommand('handoff-navigator', { navigatorUserId: handoffNavigatorId })}
            >
              {operation === 'handoff-navigator' ? 'Передаём…' : 'Передать маршрут'}
            </button>
          </div>
        </section>
      )}

      {primary && raid.state !== 'active' && raid.state !== 'paused' && raid.state !== 'finalizing' && (
        <button className="kb-primary raid-primary raid-sticky" type="button" disabled={Boolean(operation) || (primary.kind === 'command' && primary.command === 'start' && !navigator.onLine)} onClick={handlePrimary}>{operation ? 'Подтверждаем…' : primary.label}</button>
      )}
      {allowed.has('cancel') && !resource.stale && <button className="raid-cancel" type="button" disabled={operation === 'cancel'} onClick={() => window.confirm('Отменить рейд для всей команды?') && applyCommand('cancel')}>Отменить рейд</button>}
      {allowed.has('leave') && !resource.stale && <button className="raid-cancel" type="button" disabled={operation === 'leave' || !navigator.onLine} onClick={leaveCurrentRaid}>{operation === 'leave' ? 'Выходим…' : 'Выйти из рейда'}</button>}
    </RaidShell>
  )
}

function ParticipantList({ participants, navigatorId }: { participants: RaidParticipant[]; navigatorId: string | null }) {
  return <ul className="raid-participants">{participants.map((participant) => <li key={participant.id}><span className="raid-avatar">{participant.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{participant.displayName}</strong><small>{participant.id === navigatorId ? 'Навигатор · ' : ''}{participantStateLabel(participant.state)}</small></div><span className={`participant-state participant-state--${participant.state}`}>{participantStateLabel(participant.state)}</span></li>)}</ul>
}

function RaidShell({ children }: { children: ReactNode }) {
  return <main className="kb-shell raid-shell"><a className="kb-brand" href={appPath('app')} aria-label="КАБАНДА — на главную"><img src={appPath('brand/kabanda-logo-reference.png')} alt="" /><strong>КАБАНДА</strong></a>{children}</main>
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <section className="kb-card raid-empty"><h1>{title}</h1><p className="kb-muted">{detail}</p><a className="kb-link-button" href={appPath('app')}>На главную</a></section>
}

function defaultRaidTitle(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Утренний рейд'
  if (hour < 18) return 'Дневной рейд'
  return 'Вечерний рейд'
}

function stateLabel(state: RaidProjection['state']) {
  return { draft: 'Черновик', planned: 'Запланирован', lobby: 'Lobby', active: 'В пути', paused: 'Пауза', finalizing: 'Собираем итог', completed: 'Завершён', cancelled: 'Отменён' }[state]
}

function participantStateLabel(state: RaidParticipant['state']) {
  return { invited: 'Приглашён', accepted: 'Едет', ready: 'Готов', active: 'В пути', declined: 'Отказался', left: 'Вышел', removed: 'Удалён' }[state]
}

function statusIcon(status: ReadinessStatus) {
  return { pass: '✓', warn: '!', fail: '×', unknown: '?' }[status]
}

function readinessCodeLabel(code: string): string {
  const labels: Record<string, string> = {
    OFFLINE: 'Нет связи: старт ещё не может получить канонический receipt.',
    LOCATION_PERMISSION: 'Геолокация не разрешена на устройстве навигатора.',
    LOCATION_STALE: 'Свежая координата не получена за последние 30 секунд.',
    LOCATION_INACCURATE: 'Точность координаты недостаточна для старта.',
    INDEXED_DB_UNAVAILABLE: 'Локальное хранилище недоступно для записи.',
    STORAGE_UNAVAILABLE: 'Достаточный объём хранения не подтверждён.',
    REPORT_STALE: 'Readiness-отчёт устарел — проверьте телефон снова.',
    BACKGROUND_GPS_UNVERIFIED: 'Фоновый GPS не подтверждён: держите приложение открытым и экран активным.',
    STANDALONE_NOT_CONFIRMED: 'Навигатор работает в браузере, а не в установленной PWA.',
  }
  return labels[code] ?? code
}
