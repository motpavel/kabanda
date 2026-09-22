import { ResultSectionHeading } from './ResultSectionHeading'
import { useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { ApiError, requestJson } from '../../lib/http'
import { FullscreenPhoto } from '../checkins/FullscreenPhoto'
import { CachedImage } from '../../lib/CachedImage'
import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import type { MediaDraftRecord } from '../offline/types'
import type { RaidMedia, RaidMediaPage } from '../checkins/types'
import { GALLERY_PAGE_SIZE, loadGalleryWindow } from './gallery-window'
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
export function CompletedRaidGallery({ identityId, raidId, enabled, onAccessDenied, refreshKey = '' }: {
  identityId: string; raidId: string; enabled: boolean; refreshKey?: string; onAccessDenied: () => void
}) {
  const [selected, setSelected] = useState<RaidMedia | null>(null)
  const [items, setItems] = useState<RaidMedia[]>([])
  const [drafts, setDrafts] = useState<MediaDraftRecord[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localError, setLocalError] = useState(false)
  const generation = useRef(0)
  const successfulDepth = useRef(1)
  const requestedDepth = useRef(1)
  const activeDepth = useRef(0)
  const queuedDepth = useRef<number | null>(null)
  const refreshQueued = useRef(false)
  const visibleTail = useRef<string | undefined>(undefined)
  const flight = useRef<AbortController | null>(null)
  const denied = useRef(onAccessDenied)
  denied.current = onAccessDenied

  const load = async (depth = Math.max(successfulDepth.current, requestedDepth.current), invalidate = false) => {
    if (!enabled || !navigator.onLine) return
    if (flight.current) {
      if (invalidate) refreshQueued.current = true
      // Background refresh may start between pointer-down and the click. Keep
      // an explicit deeper request, rather than silently dropping the action.
      if (depth > activeDepth.current) {
        queuedDepth.current = Math.max(queuedDepth.current ?? 0, depth)
        requestedDepth.current = Math.max(requestedDepth.current, depth)
      }
      return
    }
    const current = generation.current
    const controller = new AbortController()
    flight.current = controller; activeDepth.current = depth
    requestedDepth.current = depth
    setLoading(true)
    let succeeded = false
    const deadline = setTimeout(() => controller.abort(), 15_000)
    try {
      const window = await loadGalleryWindow(depth,
        () => current === generation.current && !controller.signal.aborted,
        async after => {
          if (await getActiveIdentityId() !== identityId) throw new TypeError('Gallery identity changed')
          const query = new URLSearchParams({ limit: String(GALLERY_PAGE_SIZE) })
          if (after) query.set('cursor', after)
          return requestJson<RaidMediaPage>(`/api/raids/${encodeURIComponent(raidId)}/media?${query}`, { signal: controller.signal })
        }, visibleTail.current)
      if (current !== generation.current || controller.signal.aborted || await getActiveIdentityId() !== identityId) return
      setItems(window.items); setCursor(window.nextCursor)
      visibleTail.current = window.items.at(-1)?.id
      successfulDepth.current = window.pageCount
      requestedDepth.current = Math.max(window.pageCount, queuedDepth.current ?? 0)
      setLoaded(true); setError(null); succeeded = true
    } catch (reason) {
      if (current !== generation.current) return
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) {
        setSelected(null); setItems([]); setDrafts([]); setCursor(null); visibleTail.current = undefined
        successfulDepth.current = 1; requestedDepth.current = 1
        denied.current()
      }
      setError('Не удалось загрузить фото рейда. Уже открытые фотографии сохранены на экране. Повторите при восстановлении связи.')
    } finally {
      clearTimeout(deadline)
      if (flight.current === controller) flight.current = null
      if (current === generation.current) {
        setLoading(false)
        const next = queuedDepth.current
        queuedDepth.current = null
        // Failure remains explicit and retryable, never an automatic hot loop.
        const refreshAgain = refreshQueued.current
        refreshQueued.current = false
        if (succeeded && (refreshAgain || (next !== null && next > successfulDepth.current))) void load(Math.max(next ?? 1, successfulDepth.current))
      }
    }
  }

  useEffect(() => {
    generation.current++
    refreshQueued.current = false
    flight.current?.abort(); flight.current = null
    successfulDepth.current = 1; requestedDepth.current = 1; activeDepth.current = 0; queuedDepth.current = null; visibleTail.current = undefined
    setSelected(null); setItems([]); setDrafts([]); setCursor(null); setLoaded(false); setError(null); setLocalError(false)
    if (!enabled) return
    let active = true
    const subscription = liveQuery(async () => {
      if (await getActiveIdentityId() !== identityId) return []
      const rows = await offlineDb.mediaDrafts.where('identityId').equals(identityId)
        .filter(row => row.raidId === raidId && row.status !== 'accepted').toArray()
      return await getActiveIdentityId() === identityId ? rows : []
    }).subscribe({ next: rows => { if (active) setDrafts(rows) }, error: () => { if (active) setLocalError(true) } })
    void load(1)
    const resume = () => { if (document.visibilityState === 'visible') void load() }
    window.addEventListener('online', resume)
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      active = false; generation.current++; flight.current?.abort(); flight.current = null; queuedDepth.current = null
      subscription.unsubscribe(); window.removeEventListener('online', resume); window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [identityId, raidId, enabled])

  useEffect(() => { if (refreshKey) void load(undefined, true) }, [refreshKey])

  if (!enabled) return null
  const acceptedIds = new Set(items.map(item => item.id))
  const local = drafts.filter(draft => !acceptedIds.has(draft.mediaId ?? draft.intentId ?? ''))
  return <section className="kb-card result-gallery" aria-label="Фотографии завершённого рейда">
    <ResultSectionHeading icon="photos">Фотографии рейда</ResultSectionHeading>
    {selected && <FullscreenPhoto createdAt={selected.createdAt} onClose={() => setSelected(null)}><CachedImage identityId={identityId} src={`/api/raids/${encodeURIComponent(raidId)}/media/${encodeURIComponent(selected.id)}/content`} width={selected.width} height={selected.height} alt="Фото рейда" draggable={false} /></FullscreenPhoto>}
    {items.length > 0 && <div className="result-gallery__grid">{items.map(item => <figure key={item.id}>
      <button className="result-gallery__photo" type="button" aria-label="Открыть фото на весь экран" onClick={() => setSelected(item)}><CachedImage identityId={identityId} src={`/api/raids/${encodeURIComponent(raidId)}/media/${encodeURIComponent(item.id)}/content`}
        width={item.width} height={item.height} loading="lazy" alt={item.caption || 'Фото рейда'} /></button>
    </figure>)}</div>}
    {loaded && !items.length && !error && <p className="kb-muted">В этом рейде пока нет фотографий.</p>}
    {!loaded && !error && <p className="kb-muted" role="status">{navigator.onLine ? 'Загружаем фотографии…' : 'Для общей галереи нужно соединение.'}</p>}
    {cursor && <button type="button" aria-busy={loading} disabled={!loaded || !!error} onClick={() => void load(successfulDepth.current + 1)}>Показать ещё фотографии</button>}
    {error && <p role="status">{error} <button type="button" disabled={loading || !navigator.onLine} onClick={() => void load(requestedDepth.current)}>Повторить загрузку фотографий</button></p>}
    {local.length > 0 && <><h3>На этом телефоне</h3><div className="result-gallery__grid">{local.map(draft => <LocalPhoto key={draft.operationId} draft={draft} />)}</div></>}
    {localError && <p role="status">Не удалось проверить локальные фотографии. Не очищайте данные приложения.</p>}
  </section>
}
