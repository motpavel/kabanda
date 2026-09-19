import { useEffect, useRef, useState } from 'react'
import { ApiError, requestJson } from '../../lib/http'
import { CachedImage, clearPrivateImageCache } from '../../lib/CachedImage'
import { getActiveIdentityId } from '../offline/ledger'
import { enqueueField, pumpFieldOperations, type FieldOperation } from '../raids/field-outbox'
import { hasQuotaForMedia, prepareMediaFile, sha256Hex } from './platform'
import { consumeSelectedFile } from './selected-file'
import './point-materials.css'

export type PointMaterial = {
  id: string; pointSnapshotId: string; authorUserId: string; authorName: string
  kind: 'comment' | 'photo'; body: string; ready: boolean; width: number | null; height: number | null; createdAt: string
}
type Page = { materials: PointMaterial[]; nextCursor: string | null }
export function mergePointMaterials(current: readonly PointMaterial[], page: readonly PointMaterial[], append: boolean): PointMaterial[] {
  const combined = append ? [...current, ...page] : [...page, ...current]
  const seen = new Set<string>()
  return combined.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true })
}

export function PointMaterialsPanel({ identityId, kabandaId, raidId, pointId, visible, canWrite, operations }: {
  identityId: string; kabandaId: string; raidId: string; pointId: string; visible: boolean
  canWrite: boolean; operations: readonly FieldOperation[]
}) {
  const [items, setItems] = useState<PointMaterial[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const scope = JSON.stringify([identityId, raidId, pointId])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const generation = useRef(0)
  const headKey = useRef<string | null>(null)
  const flight = useRef<AbortController | null>(null)
  const path = `/api/raids/${encodeURIComponent(raidId)}/points/${encodeURIComponent(pointId)}/materials`
  const queue = operations.filter(row => row.pointId === pointId && row.kind !== 'team')
  const accepted = queue.filter(row => row.status === 'accepted').map(row => row.operationId).join(':')
  const pending = queue.filter(row => row.status !== 'accepted')

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
        (page.nextCursor !== null && typeof page.nextCursor !== 'string') || (after !== null && page.nextCursor === after)) {
        throw new TypeError('Invalid material list')
      }
      setItems(previous => mergePointMaterials(previous, page.materials, after !== null))
      const nextHead = page.materials.map(item => item.id).join(':')
      if (after !== null || headKey.current !== nextHead) setCursor(page.nextCursor)
      if (after === null) headKey.current = nextHead
      // An unchanged five-second head refresh must not reset a user's older
      // page cursor. A changed head reopens its gap without dropping old rows.
      setLoaded(true); setError(null); setDenied(false)
    } catch (reason) {
      if (current !== generation.current || currentScope.current !== scope) return
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) {
        setItems([]); setCursor(null); setDenied(true); headKey.current = null; clearPrivateImageCache()
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
    setItems([]); setCursor(null); setLoaded(false); setError(null); setDenied(false); setMessage(null); setText('')
    return () => { generation.current++; flight.current?.abort(); flight.current = null }
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

  const save = async (file?: File) => {
    if (busy || !canWrite || denied || (!file && !text.trim())) return
    const current = generation.current
    setBusy(true); setMessage(null)
    const body = text.trim()
    try {
      if (file) {
        const blob = await prepareMediaFile(file)
        if (await hasQuotaForMedia(blob.size) === false) throw new Error('Недостаточно места для сохранения фотографии.')
        const sourceSha256 = await sha256Hex(blob)
        if (currentScope.current !== scope || current !== generation.current) return
        await enqueueField({ identityId, kabandaId, raidId, pointId, kind: 'photo', blob,
          payload: { kind: 'photo', body, sourceSha256, contentType: 'image/jpeg', sizeBytes: blob.size } })
      } else {
        await enqueueField({ identityId, kabandaId, raidId, pointId, kind: 'comment', payload: { kind: 'comment', body } })
      }
      if (currentScope.current !== scope || current !== generation.current) return
      setText(''); setMessage(navigator.onLine ? 'Сохранено. Отправляем независимо от отметки точки.' : 'Сохранено на телефоне. Отправим после восстановления связи.')
      void pumpFieldOperations(identityId, raidId, 'materials', navigator.onLine).catch(() => undefined)
    } catch (reason) {
      if (currentScope.current === scope && current === generation.current) setMessage(reason instanceof Error ? reason.message : 'Не удалось сохранить материал. Повторите попытку.')
    } finally { if (currentScope.current === scope && current === generation.current) setBusy(false) }
  }
  return <section className="point-materials" aria-label="Фото и комментарии точки">
    <h3>Фото и комментарии</h3>
    {!loaded && !error && <p className="kb-muted">{navigator.onLine ? 'Загружаем материалы…' : 'Для загрузки материалов нужно соединение.'}</p>}
    {loaded && !items.length && <p className="kb-muted">Здесь пока нет фото и комментариев.</p>}
    {items.map(item => <article className="point-materials__item" key={item.id}>
      {item.kind === 'photo' && <CachedImage identityId={identityId} src={`${path}/${encodeURIComponent(item.id)}/content`}
        width={item.width ?? 640} height={item.height ?? 480} alt={item.body || 'Фото точки'} loading="lazy" />}
      {item.body && <p>{item.body}</p>}
      <small>{item.authorName || 'Участник рейда'} · {new Date(item.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
    </article>)}
    {cursor && <button type="button" disabled={loading} onClick={() => void refresh(cursor)}>Показать предыдущие материалы</button>}
    {error && <p role="status">{error} <button type="button" disabled={loading || !navigator.onLine} onClick={() => void refresh()}>Повторить</button></p>}
    {pending.length > 0 && <ul className="point-materials__pending">{pending.map(row => <li key={row.operationId}>
      {row.kind === 'photo' ? 'Фото' : 'Комментарий'}: {row.status === 'rejected' ? 'сервер не принял, копия сохранена на телефоне'
        : row.status === 'sending' ? 'отправляется' : 'ожидает отправки'}
    </li>)}</ul>}
    {canWrite && !denied && <div className="point-materials__compose">
      <label>Комментарий или подпись к фото<textarea maxLength={2000} rows={3} value={text} disabled={busy} onChange={event => setText(event.target.value)} /></label>
      <div><button type="button" disabled={busy || !text.trim()} onClick={() => void save()}>Добавить комментарий</button>
        <label className="checkin-photo kb-link-button">{busy ? 'Сохраняем…' : 'Добавить фото'}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => {
          void consumeSelectedFile(event.currentTarget, save)
        }} /></label></div>
      <p className="kb-muted">Материалы не создают новое посещение и не меняют баллы.</p>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>
}
