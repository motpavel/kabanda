import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../../lib/http'
import { appPath } from '../../lib/paths'
import type { KabandaSummary } from '../kabandas/types'
import { listRaidHistory } from '../results/api'
import { readRaidHistory, saveRaidHistory, newestFirst } from '../results/cache'
import { formatDistance, formatDuration } from '../results/state'
import type { RaidHistoryItem } from '../results/types'
import { listActionableRaids } from './api'
import { readActionableRaidProjections, saveRaidProjection } from './cache'
import {
  filterProductionHistory,
  historyAchievement,
  participationLabel,
  splitActionableRaids,
  type ProductionHistoryFilter,
} from './production-model'
import { selectPrimaryAction } from './state'
import type { RaidProjection } from './types'
import '../raids-design/raids-design.css'
import './production-raids.css'

type IconName = 'bike' | 'calendar' | 'camera' | 'chevron' | 'clock' | 'flag' | 'group' | 'pin' | 'route' | 'send' | 'target' | 'trophy'

const iconPaths: Record<IconName, ReactNode> = {
  bike: <><circle cx="5.5" cy="17.5" r="3.5" /><circle cx="18.5" cy="17.5" r="3.5" /><circle cx="15" cy="5" r="1" /><path d="M12 17.5V14l-3-3 4-3 2 3h2M8.5 17.5l2.5-6 2 2 2.5 4" /></>,
  calendar: <><rect x="3" y="4" width="18" height="17" rx="2.5" /><path d="M8 2v4m8-4v4M3 10h18M8 14h.01m4 0h.01m4 0h.01M8 18h.01m4 0h.01" /></>,
  camera: <><path d="M4 8h3l1.5-2h7L17 8h3v11H4Z" /><circle cx="12" cy="13.5" r="3" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>,
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
  const [loading, setLoading] = useState(true)
  const [loadIssue, setLoadIssue] = useState<string | null>(null)
  const refreshInFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    try {
      const [actionableResult, historyResult] = await Promise.allSettled([
        listActionableRaids(kabanda.id),
        listRaidHistory(kabanda.id, 12),
      ])
      let issue = false

      if (actionableResult.status === 'fulfilled') {
        setActionable(actionableResult.value)
        setActionableStaleAt(null)
        await Promise.allSettled(actionableResult.value.map((raid) => saveRaidProjection(identityId, raid)))
      } else if (actionableResult.reason instanceof ApiError && actionableResult.reason.status < 500) {
        setActionable([])
        setActionableStaleAt(null)
      } else {
        const cached = await readActionableRaidProjections(identityId, kabanda.id).catch(() => [])
        setActionable(cached.map(({ raid }) => raid))
        setActionableStaleAt(cached[0]?.savedAt ?? null)
        issue = cached.length === 0
      }

      if (historyResult.status === 'fulfilled') {
        const page = newestFirst(historyResult.value)
        setHistory(page.raids)
        setHistoryStaleAt(null)
        await saveRaidHistory(identityId, kabanda.id, page).catch(() => undefined)
      } else {
        const cached = await readRaidHistory(identityId, kabanda.id).catch(() => null)
        setHistory(cached?.page.raids ?? [])
        setHistoryStaleAt(cached?.savedAt ?? null)
        issue = issue || !cached
      }

      setLoadIssue(issue ? 'Не всё удалось обновить. Повторим автоматически, когда связь восстановится.' : null)
    } finally {
      setLoading(false)
      refreshInFlight.current = false
    }
  }, [identityId, kabanda.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh()
    }
    const timer = window.setInterval(refreshIfVisible, 5_000)
    window.addEventListener('focus', refreshIfVisible)
    window.addEventListener('online', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshIfVisible)
      window.removeEventListener('online', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [refresh])

  const { current, upcoming } = useMemo(
    () => splitActionableRaids(actionable, identityId),
    [actionable, identityId],
  )
  const staleAt = newestDate(actionableStaleAt, historyStaleAt)
  const coverImage = kabanda.coverImage ?? appPath('brand/kabanda-team-cover.jpg')

  return (
    <section className="prd-raids" data-testid="production-raids-hub" aria-busy={loading} aria-label="Рейды Кабанды">
      <header className="rdp-heading prd-raids__heading">
        <h1>Рейды</h1>
        {kabanda.role === 'owner' && (
          <a
            className="rdp-new prd-raids__new"
            data-testid="production-new-raid"
            href={`${appPath('app')}?createRaid=${encodeURIComponent(kabanda.id)}`}
          >
            <span aria-hidden="true">＋</span> Новый рейд
          </a>
        )}
      </header>

      {staleAt && (
        <div className="rdp-stale" role="status" data-testid="production-raids-stale">
          <Icon name="clock" />
          <span><strong>Показана сохранённая версия</strong><small>Копия от {new Date(staleAt).toLocaleString('ru-RU')}. Обновим после восстановления связи.</small></span>
        </div>
      )}
      {loadIssue && <p className="prd-raids__issue" role="status">{loadIssue}</p>}

      {loading ? <ProductionLoading /> : (
        <>
          {current && (
            <section className="rdp-section" aria-labelledby="production-now-heading" data-testid="production-current-raid">
              <h2 id="production-now-heading">Сейчас</h2>
              <CurrentRaidCard coverImage={coverImage} kabanda={kabanda} raid={current} stale={Boolean(actionableStaleAt)} onRefresh={refresh} />
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

          <section className="rdp-section prd-routes-empty" aria-labelledby="production-routes-heading" data-testid="production-route-catalog-empty">
            <h2 id="production-routes-heading">Доступные маршруты</h2>
            <div className="rdp-compact-empty"><span><Icon name="route" /></span><strong>Каталог маршрутов скоро появится. Пока рейд создаётся без готового шаблона.</strong></div>
          </section>
        </>
      )}
    </section>
  )
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
  const description = raid.description?.trim() || `${kabanda.name} · ${raid.participants.length} участников`

  return <article className="rdp-active prd-current-raid">
    <div className="rdp-active__top"><span className="rdp-live"><i /> {stateLabel(raid.state)}</span><span className="rdp-pill">{kabanda.name}</span></div>
    <div className="rdp-active__intro">
      <img alt="" decoding="async" src={coverImage} />
      <div><h3>{raid.title}</h3><p>{description}</p></div>
    </div>
    <dl className="rdp-active__metrics">
      <Metric icon="calendar" label="старт" value={formatScheduleShort(raid.scheduledAt)} />
      <Metric icon="group" label="участников" value={String(raid.participants.length)} />
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
  const avatars = raid.participants.slice(0, 3)
  return <a aria-label={`Открыть рейд: ${raid.title}`} className="rdp-row" href={`${appPath('app')}?raid=${encodeURIComponent(raid.id)}`}>
    <span className="rdp-row__icon"><Icon name="calendar" /></span>
    <span className="rdp-row__copy">
      <strong>{raid.title}</strong>
      <small><span>{formatSchedule(raid.scheduledAt)}</span>{avatars.length > 0 && <span aria-label={`${raid.participants.length} участников`} className="rdp-row__avatars">{avatars.map((participant) => <i aria-hidden="true" key={participant.id}>{initial(participant.displayName)}</i>)}</span>}</small>
    </span>
    <span className="rdp-row__action"><span className="rdp-row__badge">{participationLabel(raid, identityId)}</span><Icon name="chevron" size={19} /></span>
  </a>
}

function ProductionHistory({ coverImage, history }: { coverImage: string; history: RaidHistoryItem[] }) {
  const [filter, setFilter] = useState<ProductionHistoryFilter>('all')
  const visibleHistory = filterProductionHistory(history, filter)

  return <section aria-labelledby="production-history-heading" className="rdp-section rdp-section--history" data-testid="production-raid-history">
    <h2 id="production-history-heading">История</h2>
    {history.length === 0 ? (
      <div className="rdp-compact-empty"><span><Icon name="flag" /></span><strong>Завершённых рейдов пока нет.</strong></div>
    ) : (
      <>
        <div aria-label="Фильтр истории рейдов" className="rdp-history-filters" role="group">
          <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')} type="button">Все</button>
          <button aria-pressed={filter === 'mine'} onClick={() => setFilter('mine')} type="button">Мои</button>
        </div>
        <span aria-live="polite" className="rdp-history-filter-status">Показано рейдов: {visibleHistory.length}</span>
        {visibleHistory.length === 0 ? (
          <div className="rdp-compact-empty"><span><Icon name="bike" /></span><strong>В вашей личной истории рейдов пока нет.</strong></div>
        ) : (
          <div className="rdp-history-list">
            {visibleHistory.map((raid) => <ProductionHistoryCard coverImage={coverImage} key={raid.raidId} raid={raid} />)}
          </div>
        )}
      </>
    )}
  </section>
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
