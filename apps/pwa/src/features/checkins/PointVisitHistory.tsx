import { useEffect, useState } from 'react'
import type { PointVisitHistory as History } from '@kabanda/contracts'
import { requestJson } from '../../lib/http'
import { appPath } from '../../lib/paths'
import { formatVisitCount, visitsForParticipant } from './visit-history'
import './point-history.css'

const dateTime = (value: string) => new Date(value).toLocaleString('ru-RU', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

function LoadingHistory() {
  return <div className="point-visit-history__loading" role="status" aria-label="Загружаем историю"><span /><span /><span /></div>
}

function ParticipantVisits({ url, userId, currentRaidId }: { url: string; userId: string; currentRaidId?: string }) {
  const [history, setHistory] = useState<History | null>(null)
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let subscribed = true
    setBusy(true)
    setError(false)
    void requestJson<History>(`${url}?visitorId=${encodeURIComponent(userId)}&offset=${offset}`)
      .then((next) => {
        if (subscribed) setHistory((previous) => ({ ...next, entries: offset && previous ? [...previous.entries, ...next.entries] : next.entries }))
      }).catch(() => { if (subscribed) setError(true) })
      .finally(() => { if (subscribed) setBusy(false) })
    return () => { subscribed = false }
  }, [url, userId, offset, retry])

  return <div className="point-visit-history__detail">
    {busy && !history && <LoadingHistory />}
    {history && <ol className="point-visit-history__visits">{visitsForParticipant(history.entries, userId).map((visit) => <li key={visit.id}>
      <div>
        {visit.raidId ? <a href={`${appPath('app')}?raid=${encodeURIComponent(visit.raidId)}`}>{visit.title}<span aria-hidden="true">›</span></a> : <strong>{visit.title}</strong>}
        <p><time dateTime={visit.visitedAt}>{dateTime(visit.visitedAt)}</time>{visit.raidId === currentRaidId && <span> · этот рейд</span>}</p>
      </div>
    </li>)}</ol>}
    {error && <p role="alert">Не удалось загрузить посещения. <button type="button" onClick={() => setRetry((value) => value + 1)}>Повторить</button></p>}
    {history?.nextOffset != null && <button className="point-visit-history__more" type="button" disabled={busy} onClick={() => setOffset(history.nextOffset!)}>{busy ? 'Загружаем…' : 'Показать ещё'}</button>}
  </div>
}

export function PointVisitHistory({ kabandaId, pointId, identityId, currentRaidId, active = true }: {
  kabandaId: string; pointId: string; identityId: string; currentRaidId?: string; active?: boolean
}) {
  const [history, setHistory] = useState<History | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const url = `/api/kabandas/${encodeURIComponent(kabandaId)}/points/${encodeURIComponent(pointId)}/history`
  useEffect(() => {
    if (!active) { setExpandedId(null); return }
    let subscribed = true
    setBusy(true)
    setError(false)
    void requestJson<History>(url)
      .then((next) => { if (subscribed) setHistory(next) })
      .catch(() => { if (subscribed) setError(true) })
      .finally(() => { if (subscribed) setBusy(false) })
    return () => { subscribed = false }
  }, [url, identityId, retry, active])

  const visitors = history ? [
    { userId: identityId, displayName: 'Вы', count: history.personalCount },
    ...history.visitors.filter((visitor) => visitor.userId !== identityId)
      .sort((left, right) => right.count - left.count || left.displayName.localeCompare(right.displayName, 'ru')),
  ] : []

  return <section className="point-visit-history" aria-label="История посещений точки">
    <header><h3>Посещения</h3></header>
    {busy && !history && <LoadingHistory />}
    {error && <p role="alert">Не удалось загрузить историю. <button type="button" onClick={() => setRetry((value) => value + 1)}>Повторить</button></p>}
    {history && !history.visitors.length && <p className="point-visit-history__empty">Ваша Кабанда здесь ещё не была</p>}
    <ul className="point-visit-history__people">{visitors.map((visitor) => {
      const expanded = expandedId === visitor.userId
      const detailId = `point-visits-${pointId}-${visitor.userId}`
      return <li key={visitor.userId}>
        <button className="point-visit-history__person" type="button" aria-expanded={visitor.count ? expanded : undefined} aria-controls={visitor.count ? detailId : undefined} disabled={!visitor.count} onClick={() => setExpandedId(expanded ? null : visitor.userId)}>
          <span className={`point-visit-history__avatar${visitor.userId === identityId ? ' point-visit-history__avatar--self' : ''}`} aria-hidden="true">{visitor.userId === identityId ? 'Я' : visitor.displayName.trim().slice(0, 1).toUpperCase()}</span>
          <span className="point-visit-history__name">{visitor.displayName}</span>
          <span className="point-visit-history__total">{formatVisitCount(visitor.count)}</span>
          {visitor.count > 0 && <svg className="point-visit-history__chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="m5 6 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        </button>
        <div id={detailId} hidden={!expanded}>{expanded && <ParticipantVisits url={url} userId={visitor.userId} currentRaidId={currentRaidId} />}</div>
      </li>
    })}</ul>
  </section>
}
