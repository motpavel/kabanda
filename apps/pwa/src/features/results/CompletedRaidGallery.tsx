import { ResultSectionHeading } from './ResultSectionHeading'
import { useEffect, useMemo, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { FullscreenPhoto } from '../checkins/FullscreenPhoto'
import { CachedImage } from '../../lib/CachedImage'
import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import type { MediaDraftRecord } from '../offline/types'
import type { RaidMedia } from '../checkins/types'
import { galleryResource, useViewWindow } from './view-resources'
import './result-layout.css'

function LocalPhoto({ draft }: { draft: MediaDraftRecord }) {
  const [viewing, setViewing] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const next = URL.createObjectURL(draft.blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [draft.blob])
  return <figure className="result-gallery__local">
    {url && <button className="result-gallery__photo" type="button" aria-label="Открыть фото на весь экран" onClick={() => setViewing(true)}><img src={url} alt="Фото на этом телефоне" /></button>}
    {viewing && url && <FullscreenPhoto createdAt={draft.createdAt} onClose={() => setViewing(false)}><img src={url} alt="Фото на этом телефоне" /></FullscreenPhoto>}
    <figcaption>Сохранено на этом телефоне. Отправка на сервер не подтверждена.</figcaption>
  </figure>
}

/** Gallery availability is not inferred from frozen metrics or partial=true.
 * The displayed window survives refresh/page failures; access denial is not a
 * transient failure. Viewing a result never deletes or rewrites photo queues. */
export function CompletedRaidGallery({ identityId, kabandaId, raidId, enabled, onAccessDenied, refreshKey = '', staleOnly = false }: {
  identityId: string; kabandaId: string; raidId: string; enabled: boolean; staleOnly?: boolean; refreshKey?: string; onAccessDenied: () => void
}) {
  const [selected, setSelected] = useState<RaidMedia | null>(null)
  const entry = useMemo(() => galleryResource(identityId, kabandaId, raidId), [identityId, kabandaId, raidId])
  const state = useViewWindow(entry, enabled && !staleOnly)
  const items = state.data?.items ?? []
  const cursor = state.data?.nextCursor
  const loaded = state.data !== null
  const loading = state.loadingMore || state.refreshing === true || state.status === 'loading'
  const error = state.message
  const [drafts, setDrafts] = useState<MediaDraftRecord[]>([])
  const [localError, setLocalError] = useState(false)
  const denied = useRef(onAccessDenied)
  denied.current = onAccessDenied
  useEffect(() => {
    if (state.status === 'access-error') { setSelected(null); setDrafts([]); denied.current() }
  }, [state.status])
  useEffect(() => {
    setSelected(null); setDrafts([]); setLocalError(false)
    if (!enabled) return
    let active = true
    const subscription = liveQuery(async () => {
      if (await getActiveIdentityId() !== identityId) return []
      const rows = await offlineDb.mediaDrafts.where('identityId').equals(identityId)
        .filter(row => row.raidId === raidId && row.status !== 'accepted').toArray()
      return await getActiveIdentityId() === identityId ? rows : []
    }).subscribe({ next: rows => { if (active) setDrafts(rows) }, error: () => { if (active) setLocalError(true) } })
    return () => { active = false; subscription.unsubscribe() }
  }, [identityId, raidId, enabled])
  const previousRefresh = useRef(refreshKey)
  useEffect(() => {
    if (previousRefresh.current === refreshKey) return
    previousRefresh.current = refreshKey
    entry.invalidate()
    if (enabled && !staleOnly && navigator.onLine) void entry.refresh()
  }, [entry, enabled, staleOnly, refreshKey])

  if (!enabled) return null
  const acceptedIds = new Set(items.map(item => item.id))
  const local = drafts.filter(draft => !acceptedIds.has(draft.mediaId ?? draft.intentId ?? ''))
  return <section className="kb-card result-gallery" aria-label="Фотографии завершённого рейда">
    <ResultSectionHeading icon="photos">Фотографии рейда</ResultSectionHeading>
    {selected && <FullscreenPhoto createdAt={selected.createdAt} onClose={() => setSelected(null)}><CachedImage identityId={identityId} persistViewedMedia revision={selected.createdAt} src={`/api/raids/${encodeURIComponent(raidId)}/media/${encodeURIComponent(selected.id)}/content`} width={selected.width} height={selected.height} alt="Фото рейда" draggable={false} /></FullscreenPhoto>}
    {items.length > 0 && <div className="result-gallery__grid">{items.map(item => <figure key={item.id}>
      <button className="result-gallery__photo" type="button" aria-label="Открыть фото на весь экран" onClick={() => setSelected(item)}><CachedImage identityId={identityId} persistViewedMedia revision={item.createdAt} src={`/api/raids/${encodeURIComponent(raidId)}/media/${encodeURIComponent(item.id)}/content`}
        width={item.width} height={item.height} loading="lazy" alt={item.caption || 'Фото рейда'} /></button>
    </figure>)}</div>}
    {loaded && !items.length && !error && <p className="kb-muted">В этом рейде пока нет фотографий.</p>}
    {!loaded && !error && <p className="kb-muted" role="status">{navigator.onLine ? 'Загружаем фотографии…' : 'Для общей галереи нужно соединение.'}</p>}
    {cursor && <button type="button" aria-busy={loading} disabled={state.loadingMore || !loaded || state.status !== 'ready' || staleOnly} onClick={() => void state.more()}>Показать ещё фотографии</button>}
    {error && <p role="status">{error} Уже открытые фотографии сохранены на экране. <button type="button" disabled={loading || !navigator.onLine} onClick={() => void state.refresh()}>Повторить загрузку фотографий</button></p>}
    {local.length > 0 && <><h3>На этом телефоне</h3><div className="result-gallery__grid">{local.map(draft => <LocalPhoto key={draft.operationId} draft={draft} />)}</div></>}
    {localError && <p role="status">Не удалось проверить локальные фотографии. Не очищайте данные приложения.</p>}
  </section>
}
