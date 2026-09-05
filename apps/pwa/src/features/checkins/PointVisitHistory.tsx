import { useEffect, useState } from 'react'
import type { PointVisitHistory as History } from '@kabanda/contracts'
import { requestJson } from '../../lib/http'
import { appPath } from '../../lib/paths'
import './point-history.css'

const dateTime = (value: string) => new Date(value).toLocaleString('ru-RU', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

export function PointVisitHistory({ kabandaId, pointId, identityId, currentRaidId }: {
  kabandaId: string; pointId: string; identityId: string; currentRaidId?: string
}) {
  const [history, setHistory] = useState<History | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [offset, setOffset] = useState(0)
  useEffect(() => {
    let active = true
    setBusy(true)
    setError(false)
    void requestJson<History>(`/api/kabandas/${encodeURIComponent(kabandaId)}/points/${encodeURIComponent(pointId)}/history?offset=${offset}`)
      .then((next) => {
        if (active) setHistory((previous) => ({ ...next,
          entries: offset && previous ? [...previous.entries, ...next.entries.filter((entry) => !previous.entries.some(({ id }) => id === entry.id))] : next.entries,
        }))
      }).catch(() => { if (active) setError(true) })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [kabandaId, pointId, identityId, offset, retry])

  return <section className="point-visit-history" aria-label="История посещений точки">
    <header><h3>Ваши посещения</h3>{history && <strong aria-label={`Личных посещений: ${history.personalCount}`}>{history.personalCount}</strong>}</header>
    <p className="point-visit-history__hint">В этой Кабанде · подтверждённые чекины</p>
    {busy && !history && <p role="status">Загружаем историю…</p>}
    {error && <p role="alert">История недоступна без связи. <button type="button" onClick={() => setRetry((value) => value + 1)}>Повторить</button></p>}
    {history && !history.entries.length && <p>Здесь ещё никто не отмечался. Точка остаётся доступной для чекина.</p>}
    <ol>{history?.entries.map((entry) => <li key={entry.id}>
      <div className="point-visit-history__raid">
        {entry.raidId ? <a href={`${appPath('app')}?raid=${encodeURIComponent(entry.raidId)}`}>{entry.title}</a> : <strong>{entry.title}</strong>}
        {entry.mine && <span>Вы были · {entry.personalVisits}</span>}
      </div>
      <p className="point-visit-history__date">{dateTime(entry.visitedAt)}{entry.raidId === currentRaidId ? ' · этот рейд' : entry.state && entry.state !== 'completed' ? ' · ещё в пути' : ''}</p>
      <ul>{entry.visits.map((visit) => <li key={visit.id}>
        <span>{visit.displayName}{visit.userId === identityId ? ' · вы' : ''}<small>{visit.source === 'organizer_attestation' ? 'Подтвердил организатор' : visit.source === 'legacy' ? 'Отметка вне рейда' : 'Посещение подтверждено'}</small></span>
        <time dateTime={visit.visitedAt}>{new Date(visit.visitedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time>
      </li>)}</ul>
      {entry.participants.length > 0 && <details><summary>Состав рейда · {entry.participants.length}</summary><p>{entry.participants.map((person) => `${person.displayName}${person.userId === identityId ? ' (вы)' : ''}`).join(', ')}</p></details>}
    </li>)}</ol>
    {history?.nextOffset !== null && history?.nextOffset !== undefined && <button type="button" disabled={busy} onClick={() => setOffset(history.nextOffset!)}>{busy ? 'Загружаем…' : 'Показать предыдущие'}</button>}
  </section>
}
