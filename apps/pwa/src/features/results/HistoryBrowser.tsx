import { useMemo, useState, type ReactNode } from 'react'
import { historyPageResource, useRaidResource } from '../raids/resources'
import type { RaidHistoryFilter, RaidHistoryItem } from './types'
import './history-browser.css'

type Renderers = {
  renderCard: (raid: RaidHistoryItem) => ReactNode
  renderEmpty: (filter: RaidHistoryFilter) => ReactNode
}
type Scope = { identityId: string; kabandaId: string; active: boolean }

/** Each page remains an identity-bound shared resource, not a copied array.
 * Access revocation therefore removes every displayed page immediately. */
export function HistoryBrowser(props: Scope & Renderers) {
  const [filter, setFilter] = useState<RaidHistoryFilter>('all')
  return <section className="rdp-section rdp-section--history" aria-labelledby="production-history-heading" data-testid="production-raid-history">
    <h2 id="production-history-heading">История</h2>
    <div aria-label="Фильтр истории рейдов" className="rdp-history-filters" role="group">
      <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Все</button>
      <button type="button" aria-pressed={filter === 'mine'} onClick={() => setFilter('mine')}>Мои</button>
    </div>
    <HistorySlice {...props} filter={filter} key={`${props.identityId}:${props.kabandaId}:${filter}`} seenIds={[]} seenCursors={[]} />
  </section>
}

export function unseenHistory(raids: readonly RaidHistoryItem[], seen: readonly string[]): RaidHistoryItem[] {
  const ids = new Set(seen)
  return raids.filter(raid => {
    if (ids.has(raid.raidId)) return false
    ids.add(raid.raidId)
    return true
  })
}

function HistorySlice({ identityId, kabandaId, active, filter, cursor, seenIds, seenCursors, renderCard, renderEmpty }: Scope & Renderers & {
  filter: RaidHistoryFilter; cursor?: string; seenIds: readonly string[]; seenCursors: readonly string[];
}) {
  const entry = useMemo(() => historyPageResource(identityId, kabandaId, filter, cursor), [identityId, kabandaId, filter, cursor])
  const resource = useRaidResource(entry, active, cursor ? null : 60_000)
  const [expanded, setExpanded] = useState(false)
  const page = resource.data
  const retry = <button type="button" onClick={() => void resource.refresh()}>Повторить загрузку истории</button>
  if (resource.status === 'access-error') return <div className="history-browser__notice" role="alert"><p>Доступ к истории не подтверждён.</p>{retry}</div>
  if (!page) return resource.status === 'error'
    ? <div className="history-browser__notice" role="status"><p>{cursor ? 'Не удалось загрузить предыдущие рейды. Уже открытая история сохранена.' : 'История пока не загрузилась.'}</p>{retry}</div>
    : <div className="prd-history-loading" aria-busy="true"><p className="kb-muted">{cursor ? 'Загружаем предыдущие рейды…' : 'Загружаем историю…'}</p>{!cursor && <div className="prd-history-loading__card" aria-hidden="true" />}</div>

  const visible = unseenHistory(page.raids, seenIds)
  const next = page.nextCursor
  const cycle = Boolean(next && (next === cursor || seenCursors.includes(next)))
  return <>
    {resource.status === 'stale' && resource.message && <div className="history-browser__notice" role="status"><p>{resource.message}</p>{retry}</div>}
    {!cursor && page.raids.length === 0 && renderEmpty(filter)}
    <div className="rdp-history-list">{visible.map(raid => <div className="history-browser__item" key={raid.raidId}>{renderCard(raid)}</div>)}</div>
    {cycle ? <div className="history-browser__notice" role="status"><p>Не удалось продолжить список. Обновите историю.</p>{retry}</div>
      : next && expanded ? <HistorySlice
        identityId={identityId} kabandaId={kabandaId} active={active} filter={filter}
        cursor={next} key={next} seenIds={[...seenIds, ...page.raids.map(raid => raid.raidId)]}
        seenCursors={cursor ? [...seenCursors, cursor] : seenCursors}
        renderCard={renderCard} renderEmpty={renderEmpty}
      /> : next ? <button className="history-browser__more" type="button" onClick={() => setExpanded(true)}>Показать ещё</button>
        : (cursor || page.raids.length > 0) && <p className="history-browser__end">Вся доступная история загружена</p>}
  </>
}
