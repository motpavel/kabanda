import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../../lib/http'
import { appPath } from '../../lib/paths'
import type { KabandaSummary } from '../kabandas/types'
import { listActionableRaids } from './api'
import {
  readActionableRaidProjections,
  saveRaidProjection,
} from './cache'
import { selectCurrentRaid, selectPrimaryAction } from './state'
import type { RaidProjection } from './types'
import './raids.css'

export function RaidHomeCard({
  identityId,
  kabanda,
}: {
  identityId: string
  kabanda: KabandaSummary
}) {
  const [current, setCurrent] = useState<RaidProjection | null>(null)
  const [actionable, setActionable] = useState<RaidProjection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const canonicalActionable = await listActionableRaids(kabanda.id)
      const canonicalCurrent = selectCurrentRaid(canonicalActionable)
      setCurrent(canonicalCurrent)
      setActionable(canonicalActionable)
      setStale(false)
      setSavedAt(null)
      await Promise.all(
        canonicalActionable.map((raid) => saveRaidProjection(identityId, raid)),
      )
    } catch (reason) {
      if (reason instanceof ApiError && reason.status < 500) {
        setCurrent(null)
        setActionable([])
        setStale(false)
        setSavedAt(null)
        setLoading(false)
        return
      }
      const cachedActionable = await readActionableRaidProjections(identityId, kabanda.id)
      const cachedCurrent = selectCurrentRaid(cachedActionable.map(({ raid }) => raid))
      setCurrent(cachedCurrent)
      setActionable(cachedActionable.map(({ raid }) => raid))
      setStale(Boolean(cachedActionable.length))
      setSavedAt(cachedActionable[0]?.savedAt ?? null)
    } finally {
      setLoading(false)
    }
  }, [identityId, kabanda.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh()
    }
    const timer = window.setInterval(refreshIfVisible, 5_000)
    window.addEventListener('focus', refreshIfVisible)
    window.addEventListener('online', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshIfVisible)
      window.removeEventListener('online', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [refresh])

  const selected =
    current ??
    actionable.find(({ id }) => id === selectedId) ??
    (actionable.length === 1 ? actionable[0] : null)
  const primary = selected
    ? selectPrimaryAction(selected, {
        surface: 'home',
        online: navigator.onLine,
        stale,
      })
    : null

  const openRaid = () => {
    if (!selected) return
    window.location.assign(`${appPath('app')}?raid=${encodeURIComponent(selected.id)}`)
  }

  return (
    <section className="kb-card raid-home-card" aria-busy={loading}>
      <div className="kb-section-head">
        <div>
          <p className="kb-kicker">Сегодня катим</p>
          <h2>{current ? 'Рейд уже идёт' : actionable.length ? 'Ближайшие рейды' : 'Новый рейд'}</h2>
        </div>
        {selected && <span className={`raid-state raid-state--${selected.state}`}>{stateLabel(selected.state)}</span>}
      </div>

      {loading && <p className="kb-muted">Проверяем, что сейчас важно…</p>}
      {stale && (
        <p className="kb-stale" role="status">
          Сохранённая копия{savedAt ? ` от ${new Date(savedAt).toLocaleString('ru-RU')}` : ''}. Действия доступны после обновления.
        </p>
      )}

      {!current && actionable.length > 1 && (
        <fieldset className="raid-choice">
          <legend>Какой рейд открыть?</legend>
          {actionable.map((raid) => (
            <button
              key={raid.id}
              type="button"
              aria-pressed={selectedId === raid.id}
              onClick={() => setSelectedId(raid.id)}
            >
              <strong>{raid.title}</strong>
              <span>{raid.scheduledAt ? new Date(raid.scheduledAt).toLocaleString('ru-RU') : 'Старт после сбора'}</span>
            </button>
          ))}
        </fieldset>
      )}

      {selected && (
        <div className="raid-home-summary">
          <strong>{selected.title}</strong>
          <span>{selected.kabandaId === kabanda.id ? kabanda.name : 'Активный рейд другой Кабанды'}</span>
          <small>{selected.participants.length} участников · версия {selected.version}</small>
        </div>
      )}

      {!loading && !selected && (
        <p className="kb-muted">
          {kabanda.role === 'owner'
            ? 'Название и время — всё обязательное. Остальное можно решить в lobby.'
            : 'Организатор ещё не открыл новый сбор.'}
        </p>
      )}

      {primary && selected && (
        <button className="kb-primary raid-primary" type="button" onClick={primary.kind === 'refresh' ? refresh : openRaid}>
          {primary.label}
        </button>
      )}
      {!selected && kabanda.role === 'owner' && !stale && (
        <button
          className="kb-primary raid-primary"
          type="button"
          onClick={() =>
            window.location.assign(`${appPath('app')}?createRaid=${encodeURIComponent(kabanda.id)}`)
          }
        >
          Создать рейд
        </button>
      )}
    </section>
  )
}

function stateLabel(state: RaidProjection['state']): string {
  return {
    draft: 'Черновик',
    planned: 'Запланирован',
    lobby: 'Lobby',
    active: 'В пути',
    paused: 'Пауза',
    finalizing: 'Собираем итог',
    completed: 'Завершён',
    cancelled: 'Отменён',
  }[state]
}
