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

export function ResultPanel({
  identityId,
  raid,
  staleOnly,
}: {
  identityId: string
  raid: RaidProjection
  staleOnly: boolean
}) {
  const [result, setResult] = useState<RaidResult | null>(null)
  const [staleAt, setStaleAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [card, setCard] = useState<{ blob: Blob; url: string } | null>(null)
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
    const load = async () => {
      if (!staleOnly) {
        try {
          const canonical = await getRaidResult(raid.id)
          if (!active) return
          setResult(canonical)
          setStaleAt(null)
          setError(null)
          await saveRaidResult(identityId, canonical)
          const finishKey = resultOperationStorageKey('finish', identityId, raid.id)
          const finishAttempt = readSessionKey(finishKey)
          if (finishAttempt) clearResultOperationAttempt(finishKey, finishAttempt)
          const settleKey = resultOperationStorageKey('settle', identityId, raid.id)
          const settleAttempt = readSessionKey(settleKey)
          if (settleAttempt) clearResultOperationAttempt(settleKey, settleAttempt)
          return
        } catch (reason) {
          if (reason instanceof ApiError && reason.status < 500) {
            if (active) setError(reason.message)
            return
          }
        }
      }
      const cached = await readRaidResult(identityId, raid.id)
      if (!active) return
      if (cached) {
        setResult(cached.result)
        setStaleAt(cached.savedAt)
      } else setError('Канонический итог ещё не сохранён на этом устройстве.')
    }
    void load()
    return () => { active = false }
  }, [identityId, raid.id, staleOnly])

  useEffect(() => {
    if (!result || staleOnly || !navigator.onLine) return
    let active = true
    let url: string | null = null
    getShareCard(raid.id).then((blob) => {
      if (!active) return
      url = URL.createObjectURL(blob)
      setCard({ blob, url })
    }).catch(() => undefined)
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [raid.id, result, staleOnly])

  if (!result) return <section className="kb-card" aria-busy={!error}><h2>Собираем канонический итог…</h2>{error && <p className="kb-error">{error}</p>}</section>
  const rows = metricRows(result.personal, result.team)
  const share = async () => {
    if (!card) return
    try {
      const outcome = await shareResultCard(card.blob, result.raid.title, `kabanda-${result.raid.id}.png`)
      setShareMessage(outcome === 'shared' ? 'Карточка передана системному меню.' : 'Карточка скачана на устройство.')
    } catch {
      setShareMessage('Не удалось поделиться. Карточку можно скачать повторным нажатием.')
    }
  }
  return (
    <section className="result-shell">
      <article className="result-hero">
        <p className="kb-kicker">Канонический итог</p>
        <h2>{result.raid.title}</h2>
        <p>{new Date(result.raid.completedAt).toLocaleString('ru-RU')}</p>
        {result.raid.partial && <span>Partial · непринятые операции не включены</span>}
      </article>
      {staleAt && <p className="kb-stale">Сохранённая identity-bound копия от {new Date(staleAt).toLocaleString('ru-RU')}.</p>}
      <div className="result-metrics" role="table" aria-label="Личные и командные метрики">
        <div className="result-metrics__head" role="row"><span>Метрика</span><strong>Лично</strong><strong>Команда</strong></div>
        {rows.map((row) => <div key={row.id} role="row"><span>{row.label}</span><strong>{row.personal}</strong><strong>{row.team}</strong></div>)}
      </div>
      <section className="kb-card"><p className="kb-kicker">Участники</p><ul className="result-participants">{result.participants.map((participant) => <li key={participant.userId}><strong>{participant.displayName}</strong><span>{participant.metrics.uniquePoints} точек · {participant.metrics.photos} фото</span></li>)}</ul></section>
      {card && <section className="kb-card result-share"><img src={card.url} alt="Приватная карточка результата без маршрута и внутренних ID" /><button className="kb-link-button" type="button" onClick={share}>Поделиться карточкой</button>{shareMessage && <p className="kb-muted" role="status">{shareMessage}</p>}</section>}
      <ResultNextRaidAction enabled={!staleOnly && online} kabandaId={result.raid.kabandaId} />
    </section>
  )
}

export function ResultNextRaidAction({ enabled, kabandaId }: { enabled: boolean; kabandaId: string }) {
  if (!enabled) return <a
    className="kb-link-button result-next"
    href={`${appPath('app')}?kabanda=${encodeURIComponent(kabandaId)}&tab=raids`}
  >
    Вернуться к истории
  </a>
  return <a
    className="kb-link-button kb-primary raid-primary result-next"
    href={`${appPath('app')}?createRaid=${encodeURIComponent(kabandaId)}`}
  >
    Запланировать следующий рейд
  </a>
}

function readSessionKey(storageKey: string): string | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as { key?: unknown } | null
    return typeof value?.key === 'string' ? value.key : null
  } catch {
    return null
  }
}
