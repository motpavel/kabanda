import { useEffect, useState } from 'react'
import { ApiError } from '../../lib/http'
import { appPath } from '../../lib/paths'
import type { RaidProjection } from '../raids/types'
import { getRaidResult, getShareCard } from './api'
import { readRaidResult, saveRaidResult } from './cache'
import { clearResultOperationAttempt, resultOperationStorageKey } from './operation'
import { shareResultCard } from './share'
import { metricRows } from './state'
import type { RaidResult } from './types'
import { CompletedRaidRoute } from './CompletedRaidRoute'
import { RaidCompletionHero } from './RaidCompletionHero'

type ResultProps = { identityId: string; raid: RaidProjection; staleOnly: boolean }

export function ResultPanel(props: ResultProps) {
  return <ResultContent key={JSON.stringify([props.identityId, props.raid.id])} {...props} />
}

function ResultContent({ identityId, raid, staleOnly }: ResultProps) {
  const [result, setResult] = useState<RaidResult | null>(null)
  const [staleAt, setStaleAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [card, setCard] = useState<{ blob: Blob; url: string } | null>(null)
  const [cardError, setCardError] = useState(false)
  const [cardRetry, setCardRetry] = useState(0)
  const [shareMessage, setShareMessage] = useState<string | null>(null)
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)

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
    let active = true
    setLoading(true)
    setError(null)
    const load = async () => {
      if (!staleOnly && online) {
        try {
          const canonical = await getRaidResult(raid.id)
          if (!active) return
          setResult(canonical)
          setStaleAt(null)
          setDenied(false)
          await saveRaidResult(identityId, canonical).catch(() => undefined)
          const finishKey = resultOperationStorageKey('finish', identityId, raid.id)
          const finishAttempt = readSessionKey(finishKey)
          if (finishAttempt) clearResultOperationAttempt(finishKey, finishAttempt)
          const settleKey = resultOperationStorageKey('settle', identityId, raid.id)
          const settleAttempt = readSessionKey(settleKey)
          if (settleAttempt) clearResultOperationAttempt(settleKey, settleAttempt)
          return
        } catch (reason) {
          if (!active) return
          if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) {
            setDenied(true)
            setResult(null)
            setCard(null)
            setError('Результат недоступен для просмотра. Проверьте доступ и повторите.')
            return
          }
        }
      }
      // A confirmed denial must not be undone by an offline retry.
      if (denied) {
        if (active) setError('Для повторной проверки доступа нужно соединение.')
        return
      }
      const cached = await readRaidResult(identityId, raid.id).catch(() => null)
      if (!active) return
      if (cached) {
        setResult(cached.result)
        setStaleAt(cached.savedAt)
      } else setError(online ? 'Не удалось загрузить итог. Повторите попытку.' : 'Итог ещё не сохранён на этом устройстве. Подключитесь к интернету.')
    }
    void load().finally(() => { if (active) setLoading(false) })
    return () => { active = false }
    // denied belongs to this attempt's starting state; changing it alone must
    // not immediately issue another request after a confirmed rejection.
  }, [identityId, raid.id, staleOnly, retry, online])

  useEffect(() => {
    setCard(null)
    setCardError(false)
    if (!result || denied || staleOnly || !online) return
    let active = true
    let url: string | null = null
    getShareCard(raid.id).then((blob) => {
      if (!active) return
      url = URL.createObjectURL(blob)
      setCard({ blob, url })
    }).catch(() => { if (active) setCardError(true) })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [raid.id, result, denied, staleOnly, online, cardRetry])

  const share = async () => {
    if (!card || !result) return
    try {
      const outcome = await shareResultCard(card.blob, result.raid.title, `kabanda-${result.raid.id}.png`)
      setShareMessage(outcome === 'shared' ? 'Карточка передана системному меню.' : 'Карточка скачана на устройство.')
    } catch {
      setShareMessage('Не удалось поделиться. Попробуйте ещё раз.')
    }
  }
  const rows = result ? metricRows(result.personal, result.team) : []
  return (
    <section className="result-shell">
      {!denied && <RaidCompletionHero key="completion" result={result} />}
      <div className="result-completion-details" key="details">
        <h1 className="kb-visually-hidden">Итоги рейда</h1>
        <h2>{raid.title}</h2>
        {result && <p>{new Date(result.raid.completedAt).toLocaleString('ru-RU')}</p>}
        {result?.raid.partial && <p className="kb-stale">Неполный итог · несинхронизированные данные не включены</p>}
      </div>
      {staleAt && !denied && <p className="kb-stale" key="saved">Сохранённая копия от {new Date(staleAt).toLocaleString('ru-RU')}.</p>}
      {!denied && <CompletedRaidRoute key="route" identityId={identityId} raid={raid} />}
      {!result && loading && <p className="kb-muted" role="status" key="loading">Загружаем статистику…</p>}
      {error && <div className="kb-error" role="alert" key="error"><p>{error}</p><button type="button" disabled={loading || !online} onClick={() => setRetry(value => value + 1)}>Повторить загрузку итогов</button></div>}
      {result && <div className="result-metrics" role="table" aria-label="Личные и командные метрики" key="metrics">
        <div className="result-metrics__head" role="row"><span>Метрика</span><strong>Лично</strong><strong>Команда</strong></div>
        {rows.map((row) => <div key={row.id} role="row"><span>{row.label}</span><strong>{row.personal}</strong><strong>{row.team}</strong></div>)}
      </div>}
      {result && <section className="kb-card" key="participants"><p className="kb-kicker">Участники</p><ul className="result-participants">{result.participants.map((participant) => <li key={participant.userId}><strong>{participant.displayName}</strong><span>{participant.metrics.uniquePoints} точек · {participant.metrics.photos} фото</span></li>)}</ul></section>}
      {card && !denied && <section className="kb-card result-share" key="share"><img src={card.url} width="1080" height="1350" alt="Карточка с итогами рейда" /><button className="result-share__button" type="button" onClick={share}>Поделиться карточкой</button>{shareMessage && <p className="kb-muted" role="status">{shareMessage}</p>}</section>}
      {cardError && !denied && <div className="kb-notice" role="status" key="share-error">Карточку для друзей не удалось подготовить. <button type="button" onClick={() => setCardRetry(value => value + 1)}>Повторить подготовку карточки</button></div>}
      {result && <ResultNextRaidAction key="next" enabled={!staleOnly && online && !denied} kabandaId={result.raid.kabandaId} />}
      <a key="history" className="result-history-link" href={`${appPath('app')}?kabanda=${encodeURIComponent(raid.kabandaId)}&tab=raids`}>К завершённым рейдам</a>
    </section>
  )
}

export function ResultNextRaidAction({ enabled, kabandaId }: { enabled: boolean; kabandaId: string }) {
  if (!enabled) return <a className="kb-link-button result-next" href={`${appPath('app')}?kabanda=${encodeURIComponent(kabandaId)}&tab=raids`}>Вернуться к истории</a>
  return <a className="kb-link-button kb-primary raid-primary result-next" href={`${appPath('app')}?createRaid=${encodeURIComponent(kabandaId)}`}>Запланировать следующий рейд</a>
}

function readSessionKey(storageKey: string): string | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as { key?: unknown } | null
    return typeof value?.key === 'string' ? value.key : null
  } catch { return null }
}
