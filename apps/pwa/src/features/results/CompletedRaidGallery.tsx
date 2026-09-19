import { useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { ApiError, requestJson } from '../../lib/http'
import { CachedImage } from '../../lib/CachedImage'
import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import type { MediaDraftRecord } from '../offline/types'
import type { RaidMedia, RaidMediaPage } from '../checkins/types'
import './result-layout.css'

function LocalPhoto({ draft }: { draft: MediaDraftRecord }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const next = URL.createObjectURL(draft.blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [draft.blob])
  return <figure className="result-gallery__local">
    {url && <img src={url} alt={draft.caption || 'Фото, сохранённое на этом телефоне'} />}
    <figcaption>{draft.caption && <strong>{draft.caption}</strong>}Сохранено на этом телефоне. Отправка на сервер не подтверждена.</figcaption>
  </figure>
}

/** Gallery availability is not inferred from frozen metrics or partial=true.
 * A failed request and an empty gallery are different states. Existing drafts
 * are only read here: viewing a result never deletes or rewrites their queue. */
export function CompletedRaidGallery({ identityId, raidId, enabled, onAccessDenied }: {
  identityId: string; raidId: string; enabled: boolean; onAccessDenied: () => void
}) {
  const [items, setItems] = useState<RaidMedia[]>([])
  const [drafts, setDrafts] = useState<MediaDraftRecord[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localError, setLocalError] = useState(false)
  const generation = useRef(0)
  const flight = useRef<AbortController | null>(null)
  const denied = useRef(onAccessDenied)
  denied.current = onAccessDenied

  const load = async (after: string | null = null) => {
    if (!enabled || !navigator.onLine || flight.current) return
    const current = generation.current
    const controller = new AbortController()
    flight.current = controller
    setLoading(true)
    const deadline = setTimeout(() => controller.abort(), 15_000)
    try {
      const query = new URLSearchParams({ limit: '24' })
      if (after) query.set('cursor', after)
      const page = await requestJson<RaidMediaPage>(`/api/raids/${encodeURIComponent(raidId)}/media?${query}`, { signal: controller.signal })
      if (current !== generation.current || controller.signal.aborted || await getActiveIdentityId() !== identityId) return
      if (!Array.isArray(page.media) || page.media.some(item => item.state !== 'ready' || !item.id || item.width <= 0 || item.height <= 0) ||
        (page.nextCursor !== null && typeof page.nextCursor !== 'string') || (after !== null && page.nextCursor === after)) {
        throw new TypeError('Invalid gallery page')
      }
      setItems(previous => after ? [...new Map([...previous, ...page.media].map(item => [item.id, item])).values()] : page.media)
      setCursor(page.nextCursor)
      setLoaded(true)
      setError(null)
    } catch (reason) {
      if (current !== generation.current) return
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) {
        setItems([]); setDrafts([]); denied.current()
      }
      setError('Не удалось загрузить фото рейда. Повторите при восстановлении связи.')
    } finally {
      clearTimeout(deadline)
      if (flight.current === controller) flight.current = null
      if (current === generation.current) setLoading(false)
    }
  }

  useEffect(() => {
    generation.current++
    flight.current?.abort(); flight.current = null
    setItems([]); setDrafts([]); setCursor(null); setLoaded(false); setError(null); setLocalError(false)
    if (!enabled) return
    let active = true
    const subscription = liveQuery(async () => {
      if (await getActiveIdentityId() !== identityId) return []
      const rows = await offlineDb.mediaDrafts.where('identityId').equals(identityId)
        .filter(row => row.raidId === raidId && row.status !== 'accepted').toArray()
      return await getActiveIdentityId() === identityId ? rows : []
    }).subscribe({ next: rows => { if (active) setDrafts(rows) }, error: () => { if (active) setLocalError(true) } })
    void load()
    const resume = () => { if (document.visibilityState === 'visible') void load() }
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      active = false; generation.current++; flight.current?.abort(); flight.current = null
      subscription.unsubscribe(); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume)
    }
  }, [identityId, raidId, enabled])

  if (!enabled) return null
  const acceptedIds = new Set(items.map(item => item.id))
  const local = drafts.filter(draft => !acceptedIds.has(draft.mediaId ?? draft.intentId ?? ''))
  return <section className="kb-card result-gallery" aria-label="Фотографии завершённого рейда">
    <h2>Фотографии рейда</h2>
    {items.length > 0 && <div className="result-gallery__grid">{items.map(item => <figure key={item.id}>
      <CachedImage identityId={identityId} src={`/api/raids/${encodeURIComponent(raidId)}/media/${encodeURIComponent(item.id)}/content`}
        width={item.width} height={item.height} loading="lazy" alt={item.caption || 'Фото рейда'} />
      {item.caption && <figcaption>{item.caption}</figcaption>}
    </figure>)}</div>}
    {loaded && !items.length && !error && <p className="kb-muted">В общей галерее пока нет фотографий. Фото и комментарии отдельных точек можно открыть на карте.</p>}
    {!loaded && !error && <p className="kb-muted" role="status">{navigator.onLine ? 'Загружаем фотографии…' : 'Для общей галереи нужно соединение.'}</p>}
    {cursor && <button type="button" disabled={loading} onClick={() => void load(cursor)}>Показать ещё фотографии</button>}
    {error && <p role="status">{error} <button type="button" disabled={loading || !navigator.onLine} onClick={() => void load()}>Повторить загрузку фотографий</button></p>}
    {local.length > 0 && <><h3>На этом телефоне</h3><div className="result-gallery__grid">{local.map(draft => <LocalPhoto key={draft.operationId} draft={draft} />)}</div></>}
    {localError && <p role="status">Не удалось проверить локальные фотографии. Не очищайте данные приложения.</p>}
  </section>
}
