import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../lib/http'
import { resultResource, useRaidResource } from '../raids/resources'
import { useFieldQueue } from '../raids/use-field-queue'
import type { RaidProjection } from '../raids/types'
import { getShareCard } from './api'
import { clearResultOperationAttempt, resultOperationStorageKey } from './operation'
import { shareResultCard } from './share'
import { metricRows } from './state'
import { CompletedRaidRoute } from './CompletedRaidRoute'
import { CompletedRaidGallery } from './CompletedRaidGallery'
import { RaidCompletionHero } from './RaidCompletionHero'
import './result-layout.css'

type ResultProps = { identityId: string; raid: RaidProjection; staleOnly: boolean }

export function ResultPanel(props: ResultProps) {
  return <ResultContent key={JSON.stringify([props.identityId, props.raid.kabandaId, props.raid.id])} {...props} />
}

function ResultContent({ identityId, raid, staleOnly }: ResultProps) {
  const entry = useMemo(() => resultResource(identityId, raid.kabandaId, raid.id), [identityId, raid.kabandaId, raid.id])
  const state = useRaidResource(entry, !staleOnly && raid.state === 'completed', null)
  const result = state.data
  const denied = state.status === 'access-error'
  const [retrying, setRetrying] = useState(false)
  const [card, setCard] = useState<{ blob: Blob; url: string } | null>(null)
  const [cardError, setCardError] = useState(false)
  const [cardRetry, setCardRetry] = useState(0)
  const [shareMessage, setShareMessage] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const sharePending = useRef(false)
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const loading = state.status === 'loading' || retrying
  const canUseResult = Boolean(result) && state.status === 'ready' && !staleOnly && online && !denied
  const queue = useFieldQueue(identityId, raid.id, canUseResult ? 'completed' : 'unavailable')
  const canAddMaterials = canUseResult && (raid.organizerUserId === identityId || Boolean(result?.participants.some(person => person.userId === identityId)))

  useEffect(() => {
    const updateConnection = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateConnection)
    window.addEventListener('offline', updateConnection)
    return () => {
      window.removeEventListener('online', updateConnection)
      window.removeEventListener('offline', updateConnection)
    }
  }, [])

  useEffect(() => {
    if (!canUseResult) return
    // Cached metrics never authorize a write or imply successful settlement.
    for (const kind of ['finish', 'settle'] as const) {
      const key = resultOperationStorageKey(kind, identityId, raid.id)
      const attempt = readSessionKey(key)
      if (attempt) clearResultOperationAttempt(key, attempt)
    }
  }, [canUseResult, identityId, raid.id])

  useEffect(() => {
    setCard(null)
    setCardError(false)
    setShareMessage(null)
    if (!canUseResult) return
    let active = true
    let url: string | null = null
    const current = entry.readFence()
    getShareCard(raid.id).then(blob => {
      if (!active || !current()) return
      url = URL.createObjectURL(blob)
      setCard({ blob, url })
    }).catch((reason: unknown) => {
      if (!active || !current()) return
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) entry.deny()
      else setCardError(true)
    })
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [raid.id, result, canUseResult, entry, cardRetry])

  const retry = async () => {
    if (retrying || !online || staleOnly) return
    setRetrying(true)
    try { await state.refresh() } finally { setRetrying(false) }
  }
  const share = async () => {
    if (!card || !result || !canUseResult || sharePending.current) return
    sharePending.current = true
    setSharing(true)
    const current = entry.readFence()
    try {
      const outcome = await shareResultCard(card.blob, result.raid.title, `kabanda-${result.raid.id}.png`)
      if (current()) setShareMessage(outcome === 'shared' ? 'Карточка передана системному меню.' : 'Карточка скачана на устройство.')
    } catch {
      if (current()) setShareMessage('Не удалось поделиться. Попробуйте ещё раз.')
    } finally { sharePending.current = false; setSharing(false) }
  }
  const rows = result ? metricRows(result.personal, result.team) : []
  const error = denied ? 'Результат недоступен для просмотра. Проверьте доступ и повторите.'
    : state.message ?? (state.status === 'error' ? 'Не удалось загрузить итог. Повторите попытку.' : null)
  return (
    <section className="result-shell">
      {!denied && <RaidCompletionHero key="completion" result={result} />}
      <div className="result-completion-details" key="details">
        <h1 className="kb-visually-hidden">Итоги рейда</h1>
        <h2>{raid.title}</h2>
        {result && <p>{new Date(result.raid.completedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>}
        {result?.raid.partial && <details className="result-data-details"><summary>Сведения об итогах</summary>
          <p>Рейд завершён. В статистику вошли данные, которые сервер получил до завершения. Неотправленные данные остались на устройствах участников и в этот итог не включены. Просмотр фотографий доступен отдельно от статистики.</p>
        </details>}
      </div>
      {state.savedAt && !denied && <p className="kb-stale" key="saved">Сохранённая копия от {new Date(state.savedAt).toLocaleString('ru-RU')}.</p>}
      {!denied && <CompletedRaidRoute key="route" identityId={identityId} raid={raid} operations={queue.rows} canAddMaterials={canAddMaterials} />}
      {!result && loading && <p className="kb-muted" role="status" key="loading">Загружаем статистику…</p>}
      {error && <div className="kb-error" role="alert" key="error"><p>{error}</p><button type="button" disabled={loading || !online || staleOnly} onClick={() => void retry()}>Повторить загрузку итогов</button></div>}
      {result && <div className="result-metrics" role="table" aria-label="Личные и командные метрики" key="metrics">
        <div className="result-metrics__head" role="row"><span>Метрика</span><strong>Лично</strong><strong>Команда</strong></div>
        {rows.map(row => <div key={row.id} role="row"><span>{row.label}</span><strong>{row.personal}</strong><strong>{row.team}</strong></div>)}
      </div>}
      {result && <section className="result-people" key="participants"><h2>Участники</h2>
        <table className="result-people__table"><thead><tr><th scope="col">Участник</th><th scope="col">Точки</th><th scope="col">Фото</th></tr></thead>
          <tbody>{result.participants.map(participant => <tr key={participant.userId}><th scope="row">{participant.displayName}</th><td>{participant.metrics.uniquePoints}</td><td>{participant.metrics.photos}</td></tr>)}</tbody>
        </table></section>}
      <CompletedRaidGallery key="gallery" identityId={identityId} raidId={raid.id} enabled={!denied && !staleOnly} refreshKey={queue.rows.filter(row => row.kind === 'photo' && row.status === 'accepted').map(row => row.operationId).join(':')} onAccessDenied={() => entry.deny()} />
      {card && canUseResult && <section className="kb-card result-share" key="share"><img src={card.url} width="1080" height="1350" alt="Карточка с итогами рейда" /><button className="result-share__button" type="button" disabled={sharing} onClick={() => void share()}>{sharing ? 'Открываем меню…' : 'Поделиться карточкой'}</button>{shareMessage && <p className="kb-muted" role="status">{shareMessage}</p>}</section>}
      {cardError && canUseResult && <div className="kb-notice" role="status" key="share-error">Карточку для друзей не удалось подготовить. <button type="button" onClick={() => setCardRetry(value => value + 1)}>Повторить подготовку карточки</button></div>}

    </section>
  )
}

function readSessionKey(storageKey: string): string | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as { key?: unknown } | null
    return typeof value?.key === 'string' ? value.key : null
  } catch { return null }
}
