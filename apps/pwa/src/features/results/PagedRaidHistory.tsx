import { useState } from 'react'
import type { HistoryScope } from '@kabanda/contracts/exploration'
import { appPath } from '../../lib/paths'
import { RaidHubIcon as Icon } from '../raids/RaidHubIcon'
import { historyAchievement, type ProductionResourceState } from '../raids/production-model'
import type { RaidHistoryItem } from './types'
import { formatDistance, formatDuration } from './state'
import { usePagedHistory } from './exploration-resources'
import './history-pagination.css'

// Legacy presentational callers do not yet carry the participation flag.
// Connected history supplies the server-confirmed flag; never infer it from metrics.
type HistoryCardItem = RaidHistoryItem & { participated?: boolean }

export function PagedRaidHistory({ identityId, kabandaId, coverImage, active }: {
  identityId: string; kabandaId: string; coverImage: string; active: boolean
}) {
  const [scope, setScope] = useState<HistoryScope>('all')
  const history = usePagedHistory(identityId, kabandaId, scope, active)
  return <ProductionHistory
    coverImage={coverImage}
    history={history.data?.scope === scope ? history.data.raids : null}
    filter={scope} onFilterChange={setScope} status={history.status}
    message={history.message} hasMore={Boolean(history.data?.nextCursor)}
    loadingMore={history.loadingMore}
    onMore={() => void history.more()} onRetry={() => void history.refresh()}
  />
}

/** Presentational compatibility export; the connected version supplies an
 * already server-filtered window. No metric-based inference of participation. */
export function ProductionHistory({ coverImage, history, filter = 'all', onFilterChange,
  status = 'ready', message = null, hasMore = false, loadingMore = false, onMore, onRetry,
}: {
  coverImage: string; history: HistoryCardItem[] | null; filter?: HistoryScope
  onFilterChange?: (scope: HistoryScope) => void; status?: ProductionResourceState
  message?: string | null; hasMore?: boolean; loadingMore?: boolean
  onMore?: () => void; onRetry?: () => void
}) {
  const denied = status === 'access-error'
  const rows = denied ? null : history
  return <section aria-labelledby="production-history-heading" className="rdp-section rdp-section--history" data-testid="production-raid-history">
    <h2 id="production-history-heading">История</h2>
    {!denied && <div aria-label="Фильтр истории рейдов" className="rdp-history-filters" role="group">
      <button aria-pressed={filter === 'all'} onClick={() => onFilterChange?.('all')} type="button">Все</button>
      <button aria-pressed={filter === 'mine'} onClick={() => onFilterChange?.('mine')} type="button">Мои</button>
    </div>}
    {rows === null && status === 'loading' && <div className="prd-history-loading" aria-busy="true" aria-label="Загружаем историю">
      <p className="kb-muted">Загружаем историю…</p><div className="prd-history-loading__card" aria-hidden="true" />
    </div>}
    {denied && <p role="alert">Доступ к истории не подтверждён.</p>}
    {rows !== null && <>
      <span aria-live="polite" className="rdp-history-filter-status">Показано рейдов: {rows.length}</span>
      {rows.length === 0 ? <HistoryEmpty coverImage={coverImage} mine={filter === 'mine'} /> :
        <div className="rdp-history-list">{rows.map(raid => <HistoryCard key={raid.raidId} coverImage={coverImage} raid={raid} />)}</div>}
    </>}
    {(message || status === 'error' || denied) && <div className="prd-history-page-error" role="status">
      <p>{message ?? (denied ? 'История недоступна для этого аккаунта.' : 'История пока не загрузилась.')}</p>
      {onRetry && <button type="button" onClick={onRetry} disabled={loadingMore}>Повторить загрузку</button>}
    </div>}
    {rows !== null && hasMore && <div className="prd-history-pagination" aria-busy={loadingMore}>
      <button type="button" onClick={onMore} disabled={loadingMore || status !== 'ready'}>
        {loadingMore ? 'Загружаем…' : 'Показать ещё'}
      </button>
      {status === 'stale' && !message && !loadingMore && <small role="status">Проверяем историю перед подгрузкой.</small>}
    </div>}
  </section>
}

function HistoryEmpty({ coverImage, mine }: { coverImage: string; mine: boolean }) {
  return <article className="prd-empty-story">
    <img alt="" decoding="async" loading="lazy" width="1792" height="896" src={coverImage} />
    <div className="prd-empty-story__shade" />
    <div className="prd-empty-story__content">
      <span className="prd-empty-story__eyebrow"><Icon name={mine ? 'bike' : 'flag'} size={18} />{mine ? 'Личная история' : 'Всё впереди'}</span>
      <strong>{mine ? 'Ваш первый результат ещё впереди' : 'Первый финиш ещё впереди'}</strong>
      <p>{mine ? 'Пока нет завершённых рейдов с вашим подтверждённым участием.' : 'После завершения здесь появятся реальные километры, точки и фотографии команды.'}</p>
    </div>
  </article>
}

function HistoryCard({ coverImage, raid }: { coverImage: string; raid: HistoryCardItem }) {
  const achievement = historyAchievement(raid)
  const absent = raid.participated === false
  const dateLabel = new Date(raid.completedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  return <a
    aria-label={`Открыть историю рейда: ${raid.title}. ${formatDistance(raid.team.distanceMeters)}, ${raid.team.uniquePoints} точек, ${raid.team.photos} фото. ${dateLabel}${absent ? '. Вы не участвовали' : ''}`}
    className="rdp-history-card prd-history-card"
    href={`${appPath('app')}?raid=${encodeURIComponent(raid.raidId)}`}
  >
    <span className="rdp-history-card__hero prd-history-card__hero">
      <img alt="" decoding="async" loading="lazy" width="1792" height="896" src={coverImage} />
      <span className={`rdp-history-achievement rdp-history-achievement--${achievement.tone}`}><Icon name={achievement.tone === 'record' ? 'trophy' : achievement.tone === 'personal' ? 'flag' : 'pin'} size={18} />{achievement.label}</span>
    </span>
    <span className="rdp-history-card__body">
      <span className="rdp-history-card__head">
        <span className="rdp-history-card__title"><strong>{raid.title}</strong><small>{raid.partial ? 'Результат сохранён частично' : `В пути ${formatDuration(raid.team.durationSeconds)}`}</small></span>
        <span className={`prd-history-personal${absent ? ' prd-history-personal--absent' : ''}`} aria-label={absent ? 'Без личного участия' : 'Личный результат'}>{absent ? 'Не участвовали' : formatDistance(raid.personal.distanceMeters)}</span>
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
