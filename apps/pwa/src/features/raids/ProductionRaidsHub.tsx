import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../../lib/http'
import { appPath } from '../../lib/paths'
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
import { isStaleConflict, selectPrimaryAction } from './state'
import type { RaidProjection } from './types'
import { RaidTemplateCatalog } from '../raid-plans/RaidTemplateCatalog'
import '../raids-design/raids-design.css'
import './production-raids.css'

type IconName = 'bike' | 'calendar' | 'camera' | 'check' | 'chevron' | 'clock' | 'close' | 'flag' | 'group' | 'pin' | 'route' | 'send' | 'target' | 'trophy'
type InvitationCommand = 'accept' | 'decline'
type InvitationOperation = { raidId: string; command: InvitationCommand }
type InvitationNotice = { tone: 'success' | 'error'; text: string }

const iconPaths: Record<IconName, ReactNode> = {
  bike: <><circle cx="5.5" cy="17.5" r="3.5" /><circle cx="18.5" cy="17.5" r="3.5" /><circle cx="15" cy="5" r="1" /><path d="M12 17.5V14l-3-3 4-3 2 3h2M8.5 17.5l2.5-6 2 2 2.5 4" /></>,
  calendar: <><rect x="3" y="4" width="18" height="17" rx="2.5" /><path d="M8 2v4m8-4v4M3 10h18M8 14h.01m4 0h.01m4 0h.01M8 18h.01m4 0h.01" /></>,
  camera: <><path d="M4 8h3l1.5-2h7L17 8h3v11H4Z" /><circle cx="12" cy="13.5" r="3" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  flag: <><path d="M6 21V4" /><path d="M6 5c4-3 7 3 12 0v9c-5 3-8-3-12 0" /></>,
  group: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3.5 19c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M14 14c3.6-.7 5.7 1 6.5 4.5" /></>,
  pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
  route: <><circle cx="6" cy="17" r="2" /><circle cx="18" cy="7" r="2" /><path d="M8 17c6 0 2-10 8-10" /></>,
  send: <><path d="m21 3-8 18-3.5-8.5L1 9Z" /><path d="m9.5 12.5 5-4.5" /></>,
  target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3" /></>,
  trophy: <><path d="M8 4h8v4c0 4-1.5 6-4 6s-4-2-4-6zM10 14v3m4-3v3M8 21h8M10 17h4" /><path d="M8 6H4v2c0 2 1.3 3.5 4 3.5M16 6h4v2c0 2-1.3 3.5-4 3.5" /></>,
}

function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}><g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">{iconPaths[name]}</g></svg>
}

export function ProductionRaidsHub({
  identityId,
  kabanda,
}: {
  identityId: string
  kabanda: KabandaSummary
}) {
  const [actionable, setActionable] = useState<RaidProjection[]>([])
  const [history, setHistory] = useState<RaidHistoryItem[]>([])
  const [actionableStaleAt, setActionableStaleAt] = useState<string | null>(null)
  const [historyStaleAt, setHistoryStaleAt] = useState<string | null>(null)
  const [resourceState, setResourceState] = useState<ProductionResourceState>('loading')
  const [resourceMessage, setResourceMessage] = useState<string | null>(null)
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const [invitationOperation, setInvitationOperation] = useState<InvitationOperation | null>(null)
  const [invitationNotice, setInvitationNotice] = useState<InvitationNotice | null>(null)
  const refreshInFlight = useRef(false)
  const refreshRequested = useRef(false)
  const refreshCallback = useRef<() => void>(() => undefined)
  const refreshFence = useRef(new ProductionRefreshFence())
  const invitationKeys = useRef(new Map<string, string>())

  const refresh = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (refreshInFlight.current || refreshFence.current.isMutating()) {
      refreshRequested.current = true
      return
    }
    const refreshToken = refreshFence.current.beginRefresh()
    if (refreshToken === null) {
      refreshRequested.current = true
      return
    }
    refreshInFlight.current = true
    if (showLoading) setResourceState('loading')
    try {
      const [actionableResult, historyResult] = await Promise.allSettled([
        listActionableRaids(kabanda.id),
        listRaidHistory(kabanda.id, 12),
      ])
      const authoritativeFailure = [actionableResult, historyResult].find(
        (result): result is PromiseRejectedResult => result.status === 'rejected' && !shouldUseProductionCache(result.reason),
      )
      if (authoritativeFailure) {
        if (!refreshFence.current.canApplyRefresh(refreshToken)) {
          refreshRequested.current = true
          return
        }
        setActionable([])
        setHistory([])
        setActionableStaleAt(null)
        setHistoryStaleAt(null)
        setInvitationNotice(null)
        setResourceState(isAccessFailure(authoritativeFailure.reason) ? 'access-error' : 'error')
        setResourceMessage(resourceFailureMessage(authoritativeFailure.reason))
        return
      }

      const cachedActionable = actionableResult.status === 'rejected'
        ? await readActionableRaidProjections(identityId, kabanda.id).catch(() => [])
        : null
      const cachedHistory = historyResult.status === 'rejected'
        ? await readRaidHistory(identityId, kabanda.id).catch(() => null)
        : null
      const missingCache =
        (actionableResult.status === 'rejected' && cachedActionable?.length === 0) ||
        (historyResult.status === 'rejected' && !cachedHistory)

      if (!refreshFence.current.canApplyRefresh(refreshToken)) {
        refreshRequested.current = true
        return
      }
      if (missingCache) {
        setActionable([])
        setHistory([])
        setActionableStaleAt(null)
        setHistoryStaleAt(null)
        setInvitationNotice(null)
        setResourceState('error')
        setResourceMessage('Не удалось загрузить рейды, а сохранённой копии на этом устройстве нет.')
        return
      }

      const nextActionable = actionableResult.status === 'fulfilled'
        ? actionableResult.value
        : cachedActionable?.map(({ raid }) => raid) ?? []
      const canonicalHistory = historyResult.status === 'fulfilled' ? newestFirst(historyResult.value) : null
      const nextHistory = canonicalHistory?.raids ?? cachedHistory?.page.raids ?? []
      const usingCache = actionableResult.status === 'rejected' || historyResult.status === 'rejected'

      setActionable(nextActionable)
      setHistory(nextHistory)
      setActionableStaleAt(actionableResult.status === 'rejected' ? cachedActionable?.[0]?.savedAt ?? null : null)
      setHistoryStaleAt(historyResult.status === 'rejected' ? cachedHistory?.savedAt ?? null : null)
      setResourceState(usingCache ? 'stale' : 'ready')
      setResourceMessage(null)

      if (actionableResult.status === 'fulfilled') {
        await Promise.allSettled(actionableResult.value.map((raid) => saveRaidProjection(identityId, raid)))
      }
      if (canonicalHistory) await saveRaidHistory(identityId, kabanda.id, canonicalHistory).catch(() => undefined)
    } finally {
      refreshInFlight.current = false
      if (refreshRequested.current && !refreshFence.current.isMutating()) {
        refreshRequested.current = false
        queueMicrotask(() => refreshCallback.current())
      }
    }
  }, [identityId, kabanda.id])

  refreshCallback.current = () => void refresh()

  useEffect(() => {
    void refresh({ showLoading: true })
  }, [refresh])

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh()
    }
    const updateConnection = () => setOnline(navigator.onLine)
    const timer = window.setInterval(refreshIfVisible, 5_000)
    window.addEventListener('focus', refreshIfVisible)
    window.addEventListener('online', refreshIfVisible)
    window.addEventListener('online', updateConnection)
    window.addEventListener('offline', updateConnection)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshIfVisible)
      window.removeEventListener('online', refreshIfVisible)
      window.removeEventListener('online', updateConnection)
      window.removeEventListener('offline', updateConnection)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [refresh])

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
        setInvitationNotice({ tone: 'error', text: 'Рейд уже изменился. Обновили его каноническое состояние.' })
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

      {resourceState === 'stale' && staleAt && (
        <div className="rdp-stale" role="status" data-testid="production-raids-stale">
          <Icon name="clock" />
          <span><strong>Показана сохранённая версия</strong><small>Копия от {new Date(staleAt).toLocaleString('ru-RU')}. Обновим после восстановления связи.</small></span>
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
          onRetry={() => void refresh({ showLoading: true })}
        />
      ) : (
        <>
          {current && (
            <section className="rdp-section" aria-labelledby="production-now-heading" data-testid="production-current-raid">
              <h2 id="production-now-heading">Сейчас</h2>
              <CurrentRaidCard coverImage={coverImage} kabanda={kabanda} raid={current} stale={resourceState === 'stale'} onRefresh={() => void refresh()} />
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

          <ProductionHistory coverImage={coverImage} history={history} />

          <RaidTemplateCatalog kabandaId={kabanda.id} />
        </>
      )}
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
      <span aria-hidden="true">＋</span> Новый рейд
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

function CurrentRaidCard({
  coverImage,
  kabanda,
  raid,
  stale,
  onRefresh,
}: {
  coverImage: string
  kabanda: KabandaSummary
  raid: RaidProjection
  stale: boolean
  onRefresh: () => void
}) {
  const primary = selectPrimaryAction(raid, { surface: 'home', online: navigator.onLine, stale })
  const primaryLabel = primary?.label ?? 'Открыть рейд'
  const confirmedParticipants = confirmedRaidParticipants(raid)
  const description = raid.description?.trim() || `${kabanda.name} · ${confirmedParticipants.length} участников`

  return <article className="rdp-active prd-current-raid">
    <div className="rdp-active__top"><span className="rdp-live"><i /> {stateLabel(raid.state)}</span><span className="rdp-pill">{kabanda.name}</span></div>
    <div className="rdp-active__intro">
      <img alt="" decoding="async" src={coverImage} />
      <div><h3>{raid.title}</h3><p>{description}</p></div>
    </div>
    <dl className="rdp-active__metrics">
      <Metric icon="calendar" label="старт" value={formatScheduleShort(raid.scheduledAt)} />
      <Metric icon="group" label="участников" value={String(confirmedParticipants.length)} />
      <Metric icon="route" label="точек трека" value={String(raid.routeStatus.acceptedSampleCount)} />
      <Metric icon="flag" label="навигатор" value={raid.navigatorReady ? 'готов' : 'проверка'} />
    </dl>
    {primary?.kind === 'refresh' ? (
      <button className="rdp-active__cta" onClick={onRefresh} type="button"><Icon name="clock" />{primaryLabel}</button>
    ) : stale && !primary ? (
      <button className="rdp-active__cta" disabled type="button"><Icon name="clock" />Открыть после обновления</button>
    ) : (
      <a className="rdp-active__cta prd-active-link" href={`${appPath('app')}?raid=${encodeURIComponent(raid.id)}`}><Icon name="send" />{primaryLabel}</a>
    )}
  </article>
}

function Metric({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return <div><Icon name={icon} size={24} /><span><dt>{value}</dt><dd>{label}</dd></span></div>
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

function stateLabel(state: RaidProjection['state']): string {
  return {
    draft: 'Черновик',
    planned: 'Запланирован',
    lobby: 'Лобби открыто',
    active: 'Идёт сейчас',
    paused: 'На паузе',
    finalizing: 'Собираем итог',
    completed: 'Завершён',
    cancelled: 'Отменён',
  }[state]
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

function formatScheduleShort(value: string | null): string {
  if (!value) return 'без времени'
  return new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
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
