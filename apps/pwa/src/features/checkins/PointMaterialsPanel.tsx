import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError, requestJson } from '../../lib/http'
import { CachedImage, clearPrivateImageCache } from '../../lib/CachedImage'
import { getActiveIdentityId } from '../offline/ledger'
import { enqueueField, pumpFieldOperations, type FieldOperation } from '../raids/field-outbox'
import { hasQuotaForMedia, prepareMediaFile, sha256Hex } from './platform'
import { consumeSelectedFile } from './selected-file'
import { FullscreenPhoto } from './FullscreenPhoto'
import { pointCommentRows } from './point-comment-rows'
import './point-materials.css'
import { PointMaterialsHint } from './PointMaterialsHint'

export type PointMaterial = {
  id: string; pointSnapshotId: string; authorUserId: string; authorName: string
  kind: 'comment' | 'photo'; body: string; ready: boolean; width: number | null; height: number | null; createdAt: string
}
type Page = { materials: PointMaterial[]; nextCursor: string | null; canWrite?: boolean }
type LocalPhotoPreview = { id: string; url: string; createdAt: number; operationId: string | null; error: boolean }
type PhotoViewer = { kind: 'saved'; item: PointMaterial } | { kind: 'local'; preview: LocalPhotoPreview }

export function mergePointMaterials(current: readonly PointMaterial[], page: readonly PointMaterial[], append: boolean): PointMaterial[] {
  const combined = append ? [...current, ...page] : [...page, ...current]
  const seen = new Set<string>()
  return combined.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true })
}

export function PointMaterialsPanel({ identityId, kabandaId, raidId, pointId, visible, canWrite, operations, compact = false, actionsAtEnd = false, actionContainer }: {
  identityId: string; kabandaId: string; raidId: string; pointId: string; visible: boolean
  canWrite: boolean; operations: readonly FieldOperation[]; compact?: boolean; actionsAtEnd?: boolean; commentsExpanded?: boolean; actionContainer?: HTMLElement | null
}) {
  const [composerOpen, setComposerOpen] = useState(false)
  const composerId = useId()
  const commentRef = useRef<HTMLTextAreaElement>(null)
  const [items, setItems] = useState<PointMaterial[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [photoPreviews, setPhotoPreviews] = useState<LocalPhotoPreview[]>([])
  const [photoViewer, setPhotoViewer] = useState<PhotoViewer | null>(null)
  const [enqueuedComments, setEnqueuedComments] = useState<FieldOperation[]>([])
  const [permission, setPermission] = useState<{ scope: string; allowed: boolean } | null>(null)
  const previewUrls = useRef(new Set<string>())
  const scope = JSON.stringify([identityId, raidId, pointId])
  const currentScope = useRef(scope)
  currentScope.current = scope
  // Missing permission from an older server is not authorization. The caller's
  // role gate can further restrict writes, never grant them without a visit.
  const mayWrite = canWrite && !denied && permission?.scope === scope && permission.allowed
  const mayWriteRef = useRef(mayWrite)
  mayWriteRef.current = mayWrite
  const generation = useRef(0)
  const headKey = useRef<string | null>(null)
  const flight = useRef<AbortController | null>(null)
  const path = `/api/raids/${encodeURIComponent(raidId)}/points/${encodeURIComponent(pointId)}/materials`
  const queue = operations.filter(row => row.identityId === identityId && row.raidId === raidId && row.pointId === pointId)
  const accepted = queue.filter(row => row.status === 'accepted').map(row => row.operationId).join(':')

  const refresh = async (after: string | null = null) => {
    if (!visible || flight.current || !navigator.onLine || document.visibilityState !== 'visible') return
    const current = generation.current
    const controller = new AbortController()
    flight.current = controller
    setLoading(true)
    const deadline = setTimeout(() => controller.abort(), 15_000)
    try {
      const page = await requestJson<Page>(`${path}${after ? `?cursor=${encodeURIComponent(after)}` : ''}`, { signal: controller.signal })
      if (current !== generation.current || currentScope.current !== scope || controller.signal.aborted || await getActiveIdentityId() !== identityId) return
      if (!Array.isArray(page.materials) || page.materials.some(item => item.pointSnapshotId !== pointId || !item.ready || !item.id) ||
        (page.nextCursor !== null && typeof page.nextCursor !== 'string') || (after !== null && page.nextCursor === after) ||
        (page.canWrite !== undefined && typeof page.canWrite !== 'boolean')) {
        throw new TypeError('Invalid material list')
      }
      setItems(previous => mergePointMaterials(previous, page.materials, after !== null))
      setPermission({ scope, allowed: page.canWrite === true })
      const nextHead = page.materials.map(item => item.id).join(':')
      if (after !== null || headKey.current !== nextHead) setCursor(page.nextCursor)
      if (after === null) headKey.current = nextHead
      // An unchanged five-second head refresh must not reset a user's older
      // page cursor. A changed head reopens its gap without dropping old rows.
      setLoaded(true); setError(null); setDenied(false)
    } catch (reason) {
      if (current !== generation.current || currentScope.current !== scope) return
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) {
        setItems([]); setCursor(null); setDenied(true); setPermission(null); headKey.current = null; clearPrivateImageCache()
      }
      setError('Материалы точки не удалось загрузить. Сохранённые на телефоне действия не удалены.')
    } finally {
      clearTimeout(deadline)
      if (flight.current === controller) flight.current = null
      if (current === generation.current && currentScope.current === scope) setLoading(false)
    }
  }
  useEffect(() => {
    generation.current++
    flight.current?.abort(); flight.current = null; headKey.current = null
    setItems([]); setCursor(null); setLoaded(false); setError(null); setDenied(false); setMessage(null); setText(''); setPhotoPreviews([]); setPhotoViewer(null)
    setPermission(null); setEnqueuedComments([]); setComposerOpen(false)
    return () => {
      generation.current++; flight.current?.abort(); flight.current = null
      for (const url of previewUrls.current) URL.revokeObjectURL(url)
      previewUrls.current.clear()
    }
  }, [scope])
  useEffect(() => {
    if (!visible) return
    void refresh()
    const interval = setInterval(() => void refresh(), 5000)
    const resume = () => void refresh()
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => { clearInterval(interval); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume) }
  }, [scope, visible, accepted])

  useEffect(() => {
    const savedPhotos = operations.filter(operation => operation.identityId === identityId && operation.raidId === raidId && operation.pointId === pointId && operation.kind === 'photo' && operation.blob)
    setPhotoPreviews(previous => {
      let changed = false
      const next = [...previous]
      for (const operation of savedPhotos) {
        if (next.some(item => item.operationId === operation.operationId)) continue
        const url = URL.createObjectURL(operation.blob!)
        previewUrls.current.add(url)
        next.push({ id: operation.operationId, url, createdAt: operation.createdAt, operationId: operation.operationId, error: false })
        changed = true
      }
      return changed ? next : previous
    })
  }, [operations, identityId, raidId, pointId])

  useLayoutEffect(() => {
    const input = commentRef.current
    if (!compact || !composerOpen || !visible || !input) return
    const resize = () => {
      input.style.height = 'auto'
      input.style.height = `${input.scrollHeight + 2}px`
    }
    resize()
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      if (width !== lastWidth) { lastWidth = width; resize() }
    })
    let lastWidth = input.getBoundingClientRect().width
    observer.observe(input)
    return () => observer.disconnect()
  }, [compact, composerOpen, visible, text])

  useLayoutEffect(() => {
    if (compact && composerOpen && visible) {
      commentRef.current?.focus({ preventScroll: true })
      commentRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [compact, composerOpen, visible])

  const save = async (file?: File) => {
    if (busy || !mayWriteRef.current || (!file && !text.trim())) return
    const current = generation.current
    const preview = file ? (() => {
      const value = { id: crypto.randomUUID(), url: URL.createObjectURL(file), createdAt: Date.now(), operationId: null, error: false }
      previewUrls.current.add(value.url)
      setPhotoPreviews(previous => [...previous, value])
      return value
    })() : null
    setBusy(true); setMessage(null)
    const body = text.trim()
    try {
      if (file) {
        const blob = await prepareMediaFile(file)
        if (await hasQuotaForMedia(blob.size) === false) throw new Error('Недостаточно места для сохранения фотографии.')
        const sourceSha256 = await sha256Hex(blob)
        if (currentScope.current !== scope || current !== generation.current) return
        if (!mayWriteRef.current) throw new Error('Добавление фото доступно после вашей подтверждённой отметки на точке.')
        const operation = await enqueueField({ identityId, kabandaId, raidId, pointId, kind: 'photo', blob,
          payload: { kind: 'photo', body, sourceSha256, contentType: 'image/jpeg', sizeBytes: blob.size } })
        if (currentScope.current !== scope || current !== generation.current) return
        setPhotoPreviews(previous => previous.map(item => item.id === preview?.id ? { ...item, operationId: operation.operationId } : item))
      } else {
        const operation = await enqueueField({ identityId, kabandaId, raidId, pointId, kind: 'comment', payload: { kind: 'comment', body } })
        if (currentScope.current !== scope || current !== generation.current) return
        // Show the actual durable text now, before the queue hook and server
        // list update. Do not fold the editor or require opening a details block.
        setEnqueuedComments(previous => [...previous, operation])
      }
      if (currentScope.current !== scope || current !== generation.current) return
      setText('')
      void pumpFieldOperations(identityId, raidId, 'materials', navigator.onLine).catch(() => undefined)
    } catch (reason) {
      if (currentScope.current === scope && current === generation.current) {
        if (preview) setPhotoPreviews(previous => previous.map(item => item.id === preview.id ? { ...item, error: true } : item))
        setMessage(reason instanceof Error ? reason.message : 'Не удалось сохранить материал. Повторите попытку.')
      }
    } finally { if (currentScope.current === scope && current === generation.current) setBusy(false) }
  }
  const actions = compact && mayWrite ? <div className="point-materials__actions">
      <label className="checkin-photo point-materials__photo" aria-busy={busy}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M8 5 10 3h4l2 2h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="4"/></svg>
        {busy ? 'Сохраняем…' : 'Добавить фото'}<input aria-label="Добавить фото" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { void consumeSelectedFile(event.currentTarget, save) }} />
      </label>
      <button type="button" aria-expanded={composerOpen} aria-controls={composerId} onClick={() => setComposerOpen(value => !value)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5a9 9 0 0 1-9 9 10 10 0 0 1-4-.9L3 21l1.4-4.8A9 9 0 1 1 21 11.5Z"/><path d="M8 12h.01M12 12h.01M16 12h.01"/></svg>Комментарий
      </button>
    </div> : null
  const photos = denied ? [] : items.filter(item => item.kind === 'photo')
  const comments = denied ? [] : pointCommentRows(items, [...enqueuedComments, ...operations], { identityId, raidId, pointId })
  const visiblePhotoPreviews = denied ? [] : photoPreviews.filter(preview => {
    const operation = preview.operationId ? queue.find(item => item.operationId === preview.operationId) : null
    return !operation?.serverId || !photos.some(item => item.id === operation.serverId)
  })
  const photoGallery = photos.length > 0 || visiblePhotoPreviews.length > 0 ? <div className="point-materials__gallery" aria-label="Фотографии точки">
    {visiblePhotoPreviews.map(preview => {
      const operation = preview.operationId ? queue.find(item => item.operationId === preview.operationId) : null
      const failed = preview.error || operation?.status === 'rejected'
      return <button key={preview.id} type="button" className="point-materials__thumb point-materials__thumb--local" onClick={() => setPhotoViewer({ kind: 'local', preview })} aria-label={failed ? 'Фото не загружено' : 'Фото загружается'}>
        <img src={preview.url} alt="" />
        <span className={failed ? 'is-error' : ''}>{failed ? 'Ошибка' : operation?.status === 'sending' ? 'Загружаем' : operation ? 'В очереди' : 'Готовим'}</span>
      </button>
    })}
    {photos.map(item => <button key={item.id} type="button" className="point-materials__thumb" onClick={() => setPhotoViewer({ kind: 'saved', item })} aria-label="Открыть фото на весь экран">
      <CachedImage identityId={identityId} src={`${path}/${encodeURIComponent(item.id)}/content`} width={item.width ?? 240} height={item.height ?? 240} alt="" loading="lazy" />
    </button>)}
  </div> : null
  const viewer = photoViewer && !denied ? <FullscreenPhoto createdAt={photoViewer.kind === 'saved' ? photoViewer.item.createdAt : photoViewer.preview.createdAt} onClose={() => setPhotoViewer(null)}>
    {photoViewer.kind === 'saved' ? <CachedImage identityId={identityId} src={`${path}/${encodeURIComponent(photoViewer.item.id)}/content`} width={photoViewer.item.width ?? 1280} height={photoViewer.item.height ?? 960} alt={photoViewer.item.body || 'Фото точки'} draggable={false} />
      : <img src={photoViewer.preview.url} alt="Выбранное фото" draggable={false} />}
  </FullscreenPhoto> : null
  const composer = compact && mayWrite && <div id={composerId} className="point-materials__compose" hidden={!composerOpen}>
      <label>Комментарий<textarea ref={commentRef} maxLength={2000} rows={2} value={text} disabled={busy} onChange={event => setText(event.target.value)} /></label>
      <button type="button" disabled={busy || !text.trim()} onClick={() => void save()}>Добавить комментарий</button>
    </div>
  return <section className={`point-materials${compact ? ' point-materials--compact' : ''}`} aria-label="Фото и комментарии точки">
    {actionContainer ? createPortal(actions, actionContainer) : !actionsAtEnd && actions}
    {!actionsAtEnd && composer}
    {photoGallery}
    {comments.length > 0 && <section className="point-materials__history" aria-label="Комментарии точки" aria-live="polite" aria-relevant="additions text">
      {comments.map(item => <article className="point-materials__item" key={item.id} data-comment-state={item.state}>
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><strong>Комментарий:</strong> {item.body}</p>
        <small>{item.authorName} · {new Date(item.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          {item.state !== 'confirmed' && <span> · {item.state === 'rejected' ? 'Не отправлен. Копия на телефоне.'
            : item.state === 'sending' ? 'Отправляется…' : 'Ожидает отправки'}</span>}
        </small>
      </article>)}
    </section>}
    {!loaded && !error && !comments.length && <p className="kb-muted">{navigator.onLine ? 'Загружаем материалы…' : 'Для загрузки материалов нужно соединение.'}</p>}
    {loaded && !items.length && !comments.length && !visiblePhotoPreviews.length && <p className="kb-muted">Здесь пока нет фото и комментариев. {!denied && !mayWrite && <PointMaterialsHint />}</p>}
    {loaded && !denied && !mayWrite && (items.length > 0 || comments.length > 0 || visiblePhotoPreviews.length > 0) && <PointMaterialsHint />}
    {cursor && <button type="button" disabled={loading} onClick={() => void refresh(cursor)}>Показать предыдущие материалы</button>}
    {error && <p role="status">{error} <button type="button" disabled={loading || !navigator.onLine} onClick={() => void refresh()}>Повторить</button></p>}
    {!compact && mayWrite && <div className="point-materials__compose">
      <label>Комментарий или подпись к фото<textarea maxLength={2000} rows={3} value={text} disabled={busy} onChange={event => setText(event.target.value)} /></label>
      <div><button type="button" disabled={busy || !text.trim()} onClick={() => void save()}>Добавить комментарий</button>
        <label className="checkin-photo kb-link-button">{busy ? 'Сохраняем…' : 'Добавить фото'}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => {
          void consumeSelectedFile(event.currentTarget, save)
        }} /></label></div>
    </div>}
    {actionsAtEnd && <>{!actionContainer && actions}{composer}</>}
    {message && <p role="alert">{message}</p>}
    {viewer}
  </section>
}
