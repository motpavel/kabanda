import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../lib/http'
import { appPath } from '../../lib/paths'
import { clearPrivateImageCache } from '../../lib/CachedImage'
import { useVisibleRead } from './read-refresh'
import { CurrentRaidCard } from './CurrentRaidCard'
import { RaidHubIcon as Icon, type IconName } from './RaidHubIcon'
import type { KabandaSummary } from '../kabandas/types'
import { listRaidHistory } from '../results/api'
import { readRaidHistory, saveRaidHistory, newestFirst } from '../results/cache'
import { formatDistance, formatDuration } from '../results/state'
import type { RaidHistoryItem } from '../results/types'
import { listActionableRaids, sendParticipantCommand } from './api'
import { readActionableRaidProjections, saveRaidProjection } from './cache'
import {
  confirmedRaidParticipants,
  filterProductionHistory,
  historyAchievement,
  participationLabel,
  ProductionRefreshFence,
  productionResourcePolicy,
  shouldUseProductionCache,
  splitActionableRaids,
  type ProductionHistoryFilter,
  type ProductionResourceState,
} from './production-model'
import { isStaleConflict } from './state'
import type { RaidProjection } from './types'
import { RaidTemplateCatalog } from '../raid-plans/RaidTemplateCatalog'
import '../raids-design/raids-design.css'
import './production-raids.css'

type InvitationCommand = 'accept' | 'decline'
type InvitationOperation = { raidId: string; command: InvitationCommand }
type InvitationNotice = { tone: 'success' | 'error'; text: string }

export function ProductionRaidsHub({
  identityId,
  kabanda,
  active = true,
}: {
  identityId: string
  kabanda: KabandaSummary
  active?: boolean
}) {
  const [actionable, setActionable] = useState<RaidProjection[]>([])
  const [history, setHistory] = useState<RaidHistoryItem[]>([])
  const [actionableStaleAt, setActionableStaleAt] = useState<string | null>(null)
  const [historyStaleAt, setHistoryStaleAt] = useState<string | null>(null)
  const [resourceState, setResourceState] = useState<ProductionResourceState>('loading')
  const [historyState, setHistoryState] = useState<ProductionResourceState>('loading')
  const canonicalSettled = useRef({ actionable: false, history: false })
  const permissionEpoch = useRef(0)
  const [resourceMessage, setResourceMessage] = useState<string | null>(null)
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const [invitationOperation, setInvitationOperation] = useState<InvitationOperation | null>(null)
  const [invitationNotice, setInvitationNotice] = useState<InvitationNotice | null>(null)
  const refreshInFlight = useRef(false)
  const refreshRequested = useRef(false)
  const refreshCallback = useRef<() => void>(() => undefined)
  const refreshFence = useRef(new ProductionRefreshFence())
  const invitationKeys = useRef(new Map<string, string>())

  const denyAccess = useCallback((reason: unknown) => {
    permissionEpoch.current += 1
    canonicalSettled.current = { actionable: true, history: true }
    clearPrivateImageCache()
    setActionable([])
    setHistory([])
    setActionableStaleAt(null)
    setHistoryStaleAt(null)
    setInvitationNotice(null)
    setResourceState('access-error')
    setHistoryState('access-error')
    setResourceMessage(resourceFailureMessage(reason))
  }, [])

  const loadActionable = useCallback(async () => {
    if (refreshInFlight.current || refreshFence.current.isMutating()) {
      refreshRequested.current = true
      return
    }
    const refreshToken = refreshFence.current.beginRefresh()
    if (refreshToken === null) return
    refreshInFlight.current = true
    const epoch = permissionEpoch.current
    try {
      const next = await listActionableRaids(kabanda.id)
      canonicalSettled.current.actionable = true
      if (epoch !== permissionEpoch.current) return
      if (!refreshFence.current.canApplyRefresh(refreshToken)) { refreshRequested.current = true; return }
      setActionable(next)
      setActionableStaleAt(null)
      setResourceState('ready')
      setResourceMessage(null)
      await Promise.allSettled(next.map(raid => saveRaidProjection(identityId, raid)))
    } catch (reason) {
      canonicalSettled.current.actionable = true
      if (epoch !== permissionEpoch.current) return
      if (isAccessFailure(reason)) { denyAccess(reason); return }
      if (!refreshFence.current.canApplyRefresh(refreshToken)) { refreshRequested.current = true; return }
      const cached = shouldUseProductionCache(reason)
        ? await readActionableRaidProjections(identityId, kabanda.id).catch(() => []) : []
      if (epoch !== permissionEpoch.current || !refreshFence.current.canApplyRefresh(refreshToken)) return
      if (cached.length) {
        setActionable(cached.map(({ raid }) => raid))
        setActionableStaleAt(cached[0]?.savedAt ?? null)
        setResourceState('stale')
        setResourceMessage(null)
      } else {
        setActionable([])
        setResourceState('error')
        setResourceMessage(resourceFailureMessage(reason))
      }
    } finally {
      refreshInFlight.current = false
      if (refreshRequested.current && !refreshFence.current.isMutating()) {
        refreshRequested.current = false
        // Let the coalesced read settle before a mutation-triggered refresh.
        setTimeout(() => refreshCallback.current(), 0)
      }
    }
  }, [denyAccess, identityId, kabanda.id])

  const loadHistory = useCallback(async () => {
    const epoch = permissionEpoch.current
    try {
      const page = newestFirst(await listRaidHistory(kabanda.id, 12))
      canonicalSettled.current.history = true
      if (epoch !== permissionEpoch.current) return
      setHistory(page.raids)
      setHistoryState('ready')
      setHistoryStaleAt(null)
      await saveRaidHistory(identityId, kabanda.id, page).catch(() => undefined)
    } catch (reason) {
      canonicalSettled.current.history = true
      if (epoch !== permissionEpoch.current) return
      if (isAccessFailure(reason)) { denyAccess(reason); return }
      const cached = shouldUseProductionCache(reason)
        ? await readRaidHistory(identityId, kabanda.id).catch(() => null) : null
      if (epoch !== permissionEpoch.current) return
      setHistory(cached?.page.raids ?? [])
      setHistoryState(cached ? 'stale' : 'error')
      setHistoryStaleAt(cached?.savedAt ?? null)
    }
  }, [denyAccess, identityId, kabanda.id])

  useEffect(() => {
    let subscribed = true
    canonicalSettled.current = { actionable: false, history: false }
    void readActionableRaidProjections(identityId, kabanda.id).then(cached => {
      if (!subscribed || canonicalSettled.current.actionable) return
      if (!cached.length) {
        if (!navigator.onLine) { setResourceState('error'); setResourceMessage('Нет сети и сохранённых рейдов на этом устройстве.') }
        return
      }
      setActionable(cached.map(({ raid }) => raid))
      setActionableStaleAt(cached[0]?.savedAt ?? null)
      setResourceState('stale')
    }).catch(() => {
      if (subscribed && !canonicalSettled.current.actionable && !navigator.onLine) setResourceState('error')
    })
    void readRaidHistory(identityId, kabanda.id).then(cached => {
      if (!subscribed || canonicalSettled.current.history) return
      if (!cached) { if (!navigator.onLine) setHistoryState('error'); return }
      setHistory(cached.page.raids)
      setHistoryStaleAt(cached.savedAt)
      setHistoryState('stale')
    }).catch(() => {
      if (subscribed && !canonicalSettled.current.history && !navigator.onLine) setHistoryState('error')
    })
    return () => { subscribed = false }
  }, [identityId, kabanda.id])

  const refresh = useVisibleRead(loadActionable, `${identityId}:${kabanda.id}`, active, 10_000)
  const refreshHistory = useVisibleRead(loadHistory, `${identityId}:${kabanda.id}`, active, 60_000)
  refreshCallback.current = () => void refresh()
  useEffect(() => {
    const updateConnection = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateConnection)
    window.addEventListener('offline', updateConnection)
    return () => {
      window.removeEventListener('online', updateConnection)
      window.removeEventListener('offline', updateConnection)
    }
  }, [])

  const respondToInvitation = useCallback(async (raid: RaidProjection, command: InvitationCommand) => {
    if (resourceState !== 'ready' || !online || !refreshFence.current.beginMutation()) {
      if (!online) setInvitationNotice({ tone: 'error', text: 'Для ответа на приглашение нужно подключение к интернету.' })
      return
    }

    const logical = `${raid.id}:${command}:${raid.version}`
    const idempotencyKey = invitationKeys.current.get(logical) ?? crypto.randomUUID()
    invitationKeys.current.set(logical, idempotencyKey)
    setInvitationOperation({ raidId: raid.id, command })
    setInvitationNotice(null)
    let refreshAfterMutation = false

    try {
      const next = await sendParticipantCommand(raid.id, command, raid.version, idempotencyKey)
      invitationKeys.current.delete(logical)
      setActionable((current) => current.map((item) => item.id === raid.id ? next : item))
      await saveRaidProjection(identityId, next).catch(() => undefined)
      setInvitationNotice({
        tone: 'success',
        text: command === 'accept'
          ? `Вы участвуете в рейде «${raid.title}». Он появился в предстоящих.`
          : `Приглашение в рейд «${raid.title}» отклонено.`,
      })
    } catch (error) {
      if (error instanceof ApiError && isStaleConflict(error.status, error.code)) {
        invitationKeys.current.delete(logical)
        setInvitationNotice({ tone: 'error', text: 'Состав рейда изменился. Обновили список — нажмите ещё раз, чтобы отправить свой ответ.' })
        refreshAfterMutation = true
      } else if (error instanceof ApiError) {
        setInvitationNotice({ tone: 'error', text: error.message })
        if (error.status === 401 || error.status === 403 || error.status === 404 || (error.status === 409 && error.code !== 'IDEMPOTENCY_CONFLICT')) {
          invitationKeys.current.delete(logical)
          refreshAfterMutation = true
        }
      } else {
        setInvitationNotice({ tone: 'error', text: 'Ответ не отправлен. Когда связь восстановится, повтор использует тот же ключ действия.' })
      }
    } finally {
      refreshFence.current.finishMutation()
      setInvitationOperation(null)
      if (refreshAfterMutation || refreshRequested.current) {
        refreshRequested.current = false
        await refresh()
      }
    }
  }, [identityId, online, refresh, resourceState])

  const { current, invitations, upcoming } = useMemo(
    () => splitActionableRaids(actionable, identityId),
    [actionable, identityId],
  )
  const staleAt = newestDate(actionableStaleAt, historyStaleAt)
  const coverImage = kabanda.coverImage ?? appPath('brand/kabanda-team-cover.jpg')
  const resourcePolicy = productionResourcePolicy(resourceState, online)
  const canMutate = resourcePolicy.canMutate

  return (
    <section className="prd-raids" data-testid="production-raids-hub" aria-busy={resourceState === 'loading'} aria-label="Рейды Кабанды">
      <header className="rdp-heading prd-raids__heading">
        <h1>Рейды</h1>
        <ProductionCreateActions enabled={canMutate} kabandaId={kabanda.id} />
      </header>

      {(resourceState === 'stale' || historyState === 'stale') && staleAt && (
        <div className="rdp-stale" role="status" data-testid="production-raids-stale">
          <Icon name="clock" />
          <span><strong>Показана сохранённая версия</strong><small>Копия от {new Date(staleAt).toLocaleString('ru-RU')}. {online ? 'Проверяем актуальность…' : 'Обновим после восстановления связи.'}</small></span>
        </div>
      )}
      {invitationNotice && (
        <p className={`prd-raids__notice prd-raids__notice--${invitationNotice.tone}`} role={invitationNotice.tone === 'error' ? 'alert' : 'status'}>
          <Icon name={invitationNotice.tone === 'success' ? 'check' : 'clock'} size={19} />
          {invitationNotice.text}
        </p>
      )}

      {resourceState === 'loading' ? <ProductionLoading /> : resourceState === 'access-error' || resourceState === 'error' ? (
        <ProductionResourceError
          accessDenied={resourceState === 'access-error'}
          message={resourceMessage ?? 'Не удалось загрузить рейды.'}
          onRetry={() => { setResourceState('loading'); void refresh() }}
        />
      ) : (
        <>
          {current && (
            <section className="rdp-section" aria-labelledby="production-now-heading" data-testid="production-current-raid">
              <h2 id="production-now-heading">Сейчас</h2>
              <CurrentRaidCard kabanda={kabanda} raid={current} stale={resourceState === 'stale'} onRefresh={() => void refresh()} />
            </section>
          )}

          {invitations.length > 0 && (
            <section className="rdp-section prd-invitations" aria-labelledby="production-invitations-heading" data-testid="production-raid-invitations">
              <div className="prd-section-heading">
                <div><h2 id="production-invitations-heading">Приглашения</h2><p>Ответьте сейчас — рейд появится в предстоящих только после принятия.</p></div>
                <span>{invitations.length}</span>
              </div>
              {!online && <p className="prd-invitations__offline" role="status">Для ответа понадобится интернет. Открыть детали можно и сейчас.</p>}
              <div className="prd-invitations__list">
                {invitations.map((raid) => (
                  <InvitationRaidRow
                    busyCommand={invitationOperation?.raidId === raid.id ? invitationOperation.command : null}
                    disabled={!canMutate || Boolean(invitationOperation)}
                    key={raid.id}
                    onRespond={(command) => void respondToInvitation(raid, command)}
                    raid={raid}
                  />
                ))}
              </div>
            </section>
          )}

          {upcoming.length > 0 && (
            <section className="rdp-section" aria-labelledby="production-upcoming-heading" data-testid="production-upcoming-raids">
              <h2 id="production-upcoming-heading">Предстоящие</h2>
              <div className="rdp-list-card">
                {upcoming.map((raid) => <UpcomingRaidRow identityId={identityId} key={raid.id} raid={raid} />)}
              </div>
            </section>
          )}

        </>
      )}
      {resourceState !== 'access-error' && <RaidTemplateCatalog identityId={identityId} kabandaId={kabanda.id} active={active} />}
      {resourceState !== 'access-error' && (historyState === 'loading'
        ? <p className="kb-muted" aria-busy="true">Загружаем историю…</p>
        : historyState === 'error'
          ? <div role="status"><p>История пока не загрузилась.</p><button type="button" onClick={() => void refreshHistory()}>Повторить</button></div>
          : <ProductionHistory coverImage={coverImage} history={history} />)}
    </section>
  )
}

export function ProductionCreateActions({ enabled, kabandaId }: { enabled: boolean; kabandaId: string }) {
  if (!enabled) return null
  return <nav aria-label="Создание рейда и маршрута" className="prd-raids__create-actions">
    <a
      className="rdp-new prd-raids__new"
      data-testid="production-new-raid"
      href={`${appPath('app')}?createRaid=${encodeURIComponent(kabandaId)}`}
    >
      Выйти в рейд
    </a>
    <a
      className="rdp-new prd-raids__new prd-raids__new--template"
      data-testid="production-new-template"
      href={`${appPath('app')}?createRaidTemplate=${encodeURIComponent(kabandaId)}`}
    >
      <Icon name="route" size={18} /> Новый маршрут
    </a>
  </nav>
}

function ProductionResourceError({
  accessDenied,
  message,
  onRetry,
}: {
  accessDenied: boolean
  message: string
  onRetry: () => void
}) {
  return <section className="prd-resource-error" role={accessDenied ? 'alert' : 'status'}>
    <span><Icon name={accessDenied ? 'close' : 'clock'} /></span>
    <div>
      <strong>{accessDenied ? 'Доступ к рейдам не подтверждён' : 'Рейды пока не загрузились'}</strong>
      <p>{message}</p>
      <button type="button" onClick={onRetry}>Повторить</button>
    </div>
  </section>
}

export function InvitationRaidRow({
  busyCommand,
  disabled,
  onRespond,
  raid,
}: {
  busyCommand: InvitationCommand | null
  disabled: boolean
  onRespond: (command: InvitationCommand) => void
  raid: RaidProjection
}) {
  const canAccept = raid.allowedActions.includes('accept')
  const canDecline = raid.allowedActions.includes('decline')
  const participants = confirmedRaidParticipants(raid)
  const avatars = participants.slice(0, 3)

  return <article className="prd-invitation" aria-busy={Boolean(busyCommand)}>
    <div className="prd-invitation__summary">
      <span className="prd-invitation__icon"><Icon name="calendar" /></span>
      <span className="prd-invitation__copy">
        <a href={`${appPath('app')}?raid=${encodeURIComponent(raid.id)}`}>{raid.title}</a>
        <small>{formatSchedule(raid.scheduledAt)}</small>
      </span>
      {avatars.length > 0 && (
        <span aria-label={`${participants.length} подтверждённых участников`} className="rdp-row__avatars prd-invitation__avatars">
          {avatars.map((participant) => <i aria-hidden="true" key={participant.id}>{initial(participant.displayName)}</i>)}
        </span>
      )}
    </div>
    {raid.description?.trim() && <p className="prd-invitation__description">{raid.description}</p>}
    <div className="prd-invitation__actions">
      <button
        className="prd-invitation__accept"
        disabled={disabled || !canAccept}
        onClick={() => onRespond('accept')}
        type="button"
      >
        <Icon name="check" size={19} />{busyCommand === 'accept' ? 'Принимаем…' : 'Принять'}
      </button>
      <button
        className="prd-invitation__decline"
        disabled={disabled || !canDecline}
        onClick={() => onRespond('decline')}
        type="button"
      >
        <Icon name="close" size={19} />{busyCommand === 'decline' ? 'Отказываемся…' : 'Отказаться'}
      </button>
    </div>
  </article>
}

function ProductionLoading() {
  return <div className="rdp-loading prd-raids__loading" aria-label="Загружаем рейды"><i /><i /><i /></div>
}

function UpcomingRaidRow({ identityId, raid }: { identityId: string; raid: RaidProjection }) {
  const participants = confirmedRaidParticipants(raid)
  const avatars = participants.slice(0, 3)
  return <a aria-label={`Открыть рейд: ${raid.title}`} className="rdp-row" href={`${appPath('app')}?raid=${encodeURIComponent(raid.id)}`}>
    <span className="rdp-row__icon"><Icon name="calendar" /></span>
    <span className="rdp-row__copy">
      <strong>{raid.title}</strong>
      <small><span>{formatSchedule(raid.scheduledAt)}</span>{avatars.length > 0 && <span aria-label={`${participants.length} подтверждённых участников`} className="rdp-row__avatars">{avatars.map((participant) => <i aria-hidden="true" key={participant.id}>{initial(participant.displayName)}</i>)}</span>}</small>
    </span>
    <span className="rdp-row__action"><span className="rdp-row__badge">{participationLabel(raid, identityId)}</span><Icon name="chevron" size={19} /></span>
  </a>
}

export function ProductionHistory({ coverImage, history }: { coverImage: string; history: RaidHistoryItem[] }) {
  const [filter, setFilter] = useState<ProductionHistoryFilter>('all')
  const visibleHistory = filterProductionHistory(history, filter)

  return <section aria-labelledby="production-history-heading" className="rdp-section rdp-section--history" data-testid="production-raid-history">
    <h2 id="production-history-heading">История</h2>
    {history.length === 0 ? (
      <RaidEmptyState
        detail="После завершения здесь появятся только реальные километры, точки и фотографии команды."
        eyebrow="Всё впереди"
        icon="flag"
        image={coverImage}
        title="Первый финиш ещё впереди"
      />
    ) : (
      <>
        <div aria-label="Фильтр истории рейдов" className="rdp-history-filters" role="group">
          <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')} type="button">Все</button>
          <button aria-pressed={filter === 'mine'} onClick={() => setFilter('mine')} type="button">Мои</button>
        </div>
        <span aria-live="polite" className="rdp-history-filter-status">Показано рейдов: {visibleHistory.length}</span>
        {visibleHistory.length === 0 ? (
          <RaidEmptyState
            detail="Вы ещё не участвовали в завершённых рейдах этой Кабанды."
            eyebrow="Личная история"
            icon="bike"
            image={coverImage}
            title="Ваш первый результат ещё впереди"
          />
        ) : (
          <div className="rdp-history-list">
            {visibleHistory.map((raid) => <ProductionHistoryCard coverImage={coverImage} key={raid.raidId} raid={raid} />)}
          </div>
        )}
      </>
    )}
  </section>
}

function RaidEmptyState({
  actionHref,
  actionLabel,
  detail,
  eyebrow,
  icon,
  image,
  title,
}: {
  actionHref?: string
  actionLabel?: string
  detail: string
  eyebrow: string
  icon: IconName
  image: string
  title: string
}) {
  return <article className="prd-empty-story">
    <img alt="" decoding="async" loading="lazy" src={image} />
    <div className="prd-empty-story__shade" />
    <div className="prd-empty-story__content">
      <span className="prd-empty-story__eyebrow"><Icon name={icon} size={18} />{eyebrow}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
      {actionHref && actionLabel && <a className="prd-empty-story__action" href={actionHref}>{actionLabel}<Icon name="chevron" size={18} /></a>}
    </div>
  </article>
}

function ProductionHistoryCard({ coverImage, raid }: { coverImage: string; raid: RaidHistoryItem }) {
  const achievement = historyAchievement(raid)
  const dateLabel = new Date(raid.completedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  return <a
    aria-label={`Открыть историю рейда: ${raid.title}. ${formatDistance(raid.team.distanceMeters)}, ${raid.team.uniquePoints} точек, ${raid.team.photos} фото. ${dateLabel}`}
    className="rdp-history-card prd-history-card"
    href={`${appPath('app')}?raid=${encodeURIComponent(raid.raidId)}`}
  >
    <span className="rdp-history-card__hero prd-history-card__hero">
      <img alt="" decoding="async" loading="lazy" src={coverImage} />
      <span className={`rdp-history-achievement rdp-history-achievement--${achievement.tone}`}><Icon name={achievement.tone === 'record' ? 'trophy' : achievement.tone === 'personal' ? 'flag' : 'pin'} size={18} />{achievement.label}</span>
    </span>
    <span className="rdp-history-card__body">
      <span className="rdp-history-card__head">
        <span className="rdp-history-card__title"><strong>{raid.title}</strong><small>{raid.partial ? 'Результат сохранён частично' : `В пути ${formatDuration(raid.team.durationSeconds)}`}</small></span>
        <span className="prd-history-personal" aria-label="Личный результат">{formatDistance(raid.personal.distanceMeters)}</span>
      </span>
      <span className="rdp-history-card__metrics">
        <span><Icon name="route" size={18} />{formatDistance(raid.team.distanceMeters)}</span>
        <span><Icon name="target" size={18} />{raid.team.uniquePoints} точек</span>
        <span><Icon name="camera" size={18} />{raid.team.photos} фото</span>
      </span>
      <span className="rdp-history-card__date"><Icon name="calendar" size={18} /><time dateTime={raid.completedAt}>{dateLabel}</time><Icon name="chevron" size={20} /></span>
    </span>
  </a>
}

function formatSchedule(value: string | null): string {
  if (!value) return 'Старт после сбора'
  return new Date(value).toLocaleString('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function initial(value: string): string {
  return value.trim().slice(0, 1).toUpperCase() || '•'
}

function newestDate(left: string | null, right: string | null): string | null {
  if (!left) return right
  if (!right) return left
  return Date.parse(left) >= Date.parse(right) ? left : right
}

function isAccessFailure(reason: unknown): boolean {
  return reason instanceof ApiError && (reason.status === 401 || reason.status === 403 || reason.status === 404)
}

function resourceFailureMessage(reason: unknown): string {
  if (reason instanceof ApiError) return reason.message
  return 'Не удалось получить каноническое состояние рейдов.'
}
