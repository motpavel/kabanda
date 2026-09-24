import { useEffect, useMemo, useState } from 'react'
import { visitHistoryResource, useViewWindow, COMPLETED_REFRESH_MS } from '../results/view-resources'
import { useRaidResource } from '../raids/resources'
import { appPath } from '../../lib/paths'
import { formatVisitCount, visitsForParticipant } from './visit-history'
import './point-history.css'
import { PointMaterialsHint } from './PointMaterialsHint'

const dateTime = (value: string) => new Date(value).toLocaleString('ru-RU', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

function HistoryChevron({ right = false }: { right?: boolean }) {
  return <svg className={`point-visit-history__chevron${right ? ' point-visit-history__chevron--right' : ''}`} aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="m5 6 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function LoadingHistory() {
  return <div className="point-visit-history__loading" role="status" aria-label="Загружаем историю"><span /><span /><span /></div>
}

/** The map projection describes this raid only, not the all-time history. */
export type KnownRaidPointVisit = { visitedByMe: boolean; visitedByTeam: boolean; stale?: boolean }

function KnownRaidVisit({ visit }: { visit: KnownRaidPointVisit }) {
  return <div className="point-visit-history__empty">
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12Z" /><circle cx="12" cy="9" r="2.5" /></svg>
    <p>{visit.visitedByMe ? 'Вы уже отмечены здесь в этом рейде.' : visit.visitedByTeam
      ? 'Кабанда уже отмечена здесь в этом рейде.' : 'В этом рейде кабанда здесь ещё не была.'}
      {visit.stale && <small className="point-visit-history__saved">По последним данным</small>}</p>
  </div>
}

function ParticipantVisits({ identityId, kabandaId, pointId, userId, active, currentRaidId, onOpenRaid }: {
  identityId: string; kabandaId: string; pointId: string; userId: string; active: boolean; currentRaidId?: string; onOpenRaid?: () => void
}) {
  const entry = useMemo(() => visitHistoryResource(identityId, kabandaId, pointId, userId), [identityId, kabandaId, pointId, userId])
  const state = useViewWindow(entry, active)
  const history = state.data
  const busy = state.status === 'loading' || state.loadingMore
  const error = state.message

  return <div className="point-visit-history__detail">
    {busy && !history && <LoadingHistory />}
    {history && <ol className="point-visit-history__visits">{visitsForParticipant(history.entries, userId).map((visit) => <li key={visit.id}>
      {visit.raidId ? <a className="point-visit-history__raid" href={`${appPath('app')}?raid=${encodeURIComponent(visit.raidId)}`} onClick={onOpenRaid}>
        <span><strong>{visit.title}</strong><time dateTime={visit.visitedAt}>{dateTime(visit.visitedAt)}{visit.raidId === currentRaidId && ' · этот рейд'}</time></span>
        <HistoryChevron right />
      </a> : <div><strong>{visit.title}</strong><p><time dateTime={visit.visitedAt}>{dateTime(visit.visitedAt)}</time></p></div>}
    </li>)}</ol>}
    {error && <p role="alert">Не удалось загрузить посещения. <button type="button" onClick={() => void state.refresh()}>Повторить</button></p>}
    {history?.nextOffset != null && <button className="point-visit-history__more" type="button" disabled={busy || state.status !== 'ready'} onClick={() => void state.more()}>{busy ? 'Загружаем…' : 'Показать ещё'}</button>}
  </div>
}

export function PointVisitHistory({ kabandaId, pointId, identityId, currentRaidId, knownVisit, knownUnvisited = false, compactLoading = false, active = true, showHeading = true, onOpenRaid }: {
  kabandaId: string; pointId: string; identityId: string; currentRaidId?: string; knownVisit?: KnownRaidPointVisit
  knownUnvisited?: boolean; compactLoading?: boolean; active?: boolean; showHeading?: boolean; onOpenRaid?: () => void
}) {
  const entry = useMemo(() => visitHistoryResource(identityId, kabandaId, pointId), [identityId, kabandaId, pointId])
  const state = useRaidResource(entry, active, null, COMPLETED_REFRESH_MS)
  const history = state.data
  const error = state.message
  const busy = state.status === 'loading'
  const showKnownEmpty = knownUnvisited && !currentRaidId && state.status !== 'access-error' && !history
  const summary = currentRaidId && state.status !== 'access-error' ? knownVisit : undefined
  const [openedIds, setOpenedIds] = useState<Set<string>>(() => new Set())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  useEffect(() => { if (!active) setExpandedId(null) }, [active])
  useEffect(() => { setOpenedIds(new Set()); setExpandedId(null) }, [identityId, kabandaId, pointId])

  const visitors = history ? [
    { userId: identityId, displayName: history.visitors.find(visitor => visitor.userId === identityId)?.displayName ?? 'Я', count: history.personalCount },
    ...history.visitors.filter((visitor) => visitor.userId !== identityId)
      .sort((left, right) => right.count - left.count || left.displayName.localeCompare(right.displayName, 'ru')),
  ].filter((visitor) => visitor.count > 0) : []
  // A live visit can arrive before a previously cached empty history refreshes.
  // Keep the confirmed raid status instead of briefly claiming no visits exist.
  const showKnownVisit = Boolean(summary && (!history || !visitors.length))

  return <section className="point-visit-history point-history-section" aria-label="История посещений точки">
    {showHeading && <header><h3>История посещений</h3></header>}
    {showKnownVisit && summary && <KnownRaidVisit visit={summary} />}
    {busy && !history && !showKnownEmpty && !summary && (compactLoading
      ? <p className="point-visit-history__pending" role="status">Уточняем историю…</p> : <LoadingHistory />)}
    {error && <p role="alert">Не удалось загрузить историю. <button type="button" onClick={() => void state.refresh()}>Повторить</button></p>}
    {(showKnownEmpty || (history && !visitors.length && !showKnownVisit)) && <div className="point-visit-history__empty"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12Z" /><circle cx="12" cy="9" r="2.5" /></svg><p>Ваша кабанда здесь ещё не была. <PointMaterialsHint /></p></div>}
    <ul className="point-visit-history__people">{visitors.map((visitor) => {
      const expanded = expandedId === visitor.userId
      const detailId = `point-visits-${pointId}-${visitor.userId}`
      return <li key={visitor.userId}>
        <button className="point-visit-history__person" type="button" aria-expanded={visitor.count ? expanded : undefined} aria-controls={visitor.count ? detailId : undefined} disabled={!visitor.count} onClick={() => { setOpenedIds(previous => new Set(previous).add(visitor.userId)); setExpandedId(expanded ? null : visitor.userId) }}>
          <span className={`point-visit-history__avatar${visitor.userId === identityId ? ' point-visit-history__avatar--self' : ''}`} aria-hidden="true">{visitor.userId === identityId ? 'Я' : visitor.displayName.trim().slice(0, 1).toUpperCase()}</span>
          <span className="point-visit-history__name">{visitor.displayName}</span>
          <span className="point-visit-history__total">{formatVisitCount(visitor.count)}</span>
          {visitor.count > 0 && <HistoryChevron />}
        </button>
        <div id={detailId} className="point-visit-history__reveal" data-expanded={expanded} inert={!expanded} aria-hidden={!expanded}><div>{openedIds.has(visitor.userId) && <ParticipantVisits active={active && expanded} identityId={identityId} kabandaId={kabandaId} pointId={pointId} userId={visitor.userId} currentRaidId={currentRaidId} onOpenRaid={onOpenRaid} />}</div></div>
      </li>
    })}</ul>
  </section>
}
