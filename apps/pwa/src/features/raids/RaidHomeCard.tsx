import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../../lib/http'
import { appPath } from '../../lib/paths'
import type { KabandaSummary } from '../kabandas/types'
import { listActionableRaids } from './api'
import {
  readActionableRaidProjections,
  saveRaidProjection,
} from './cache'
import { confirmedRaidParticipants, productionResourcePolicy, splitActionableRaids, type ProductionResourceState } from './production-model'
import { selectPrimaryAction } from './state'
import type { RaidProjection } from './types'
import './raids.css'

export function RaidHomeCard({
  identityId,
  kabanda,
}: {
  identityId: string
  kabanda: KabandaSummary
}) {
  const [actionable, setActionable] = useState<RaidProjection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [resourceState, setResourceState] = useState<ProductionResourceState>('loading')
  const [resourceMessage, setResourceMessage] = useState<string | null>(null)
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)

  const refresh = useCallback(async () => {
    try {
      const canonicalActionable = await listActionableRaids(kabanda.id)
      setActionable(canonicalActionable)
      setStale(false)
      setSavedAt(null)
      setResourceState('ready')
      setResourceMessage(null)
      await Promise.all(
        canonicalActionable.map((raid) => saveRaidProjection(identityId, raid)),
      )
    } catch (reason) {
      if (reason instanceof ApiError && reason.status < 500) {
        setActionable([])
        setStale(false)
        setSavedAt(null)
        setResourceState(reason.status === 401 || reason.status === 403 || reason.status === 404 ? 'access-error' : 'error')
        setResourceMessage(reason.message)
        return
      }
      const cachedActionable = await readActionableRaidProjections(identityId, kabanda.id).catch(() => [])
      if (cachedActionable.length > 0) {
        setActionable(cachedActionable.map(({ raid }) => raid))
        setStale(true)
        setSavedAt(cachedActionable[0]?.savedAt ?? null)
        setResourceState('stale')
        setResourceMessage(null)
      } else {
        setActionable([])
        setStale(false)
        setSavedAt(null)
        setResourceState('error')
        setResourceMessage('Не удалось загрузить рейды, а сохранённой копии на этом устройстве нет.')
      }
    }
  }, [identityId, kabanda.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh()
    }
    const updateConnection = () => setOnline(navigator.onLine)
    const timer = window.setInterval(refreshIfVisible, 5_000)
    window.addEventListener('focus', refreshIfVisible)
    window.addEventListener('online', refreshIfVisible)
    window.addEventListener('online', updateConnection)
    window.addEventListener('offline', updateConnection)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshIfVisible)
      window.removeEventListener('online', refreshIfVisible)
      window.removeEventListener('online', updateConnection)
      window.removeEventListener('offline', updateConnection)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [refresh])

  const { current, upcoming } = splitActionableRaids(actionable, identityId)
  const resourcePolicy = productionResourcePolicy(resourceState, online)
  const selected =
    current ??
    upcoming.find(({ id }) => id === selectedId) ??
    (upcoming.length === 1 ? upcoming[0] : null)
  const primary = selected
    ? selectPrimaryAction(selected, {
        surface: 'home',
        online,
        stale,
      })
    : null

  const openRaid = () => {
    if (!selected) return
    window.location.assign(`${appPath('app')}?raid=${encodeURIComponent(selected.id)}`)
  }

  return (
    <section className="kb-card raid-home-card" aria-busy={resourceState === 'loading'}>
      <div className="kb-section-head">
        <div>
          <h2>{current ? 'Рейд уже идёт' : upcoming.length ? 'Ближайшие рейды' : 'Новый рейд'}</h2>
          <p>Главное действие команды прямо сейчас.</p>
        </div>
        {selected && <span className={`raid-state raid-state--${selected.state}`}>{stateLabel(selected.state)}</span>}
      </div>

      {resourceState === 'loading' && <p className="kb-muted">Проверяем, что сейчас важно…</p>}
      {stale && (
        <p className="kb-stale" role="status">
          Сохранённая копия{savedAt ? ` от ${new Date(savedAt).toLocaleString('ru-RU')}` : ''}. Действия доступны после обновления.
        </p>
      )}

      {(resourceState === 'access-error' || resourceState === 'error') && (
        <div className={resourceState === 'access-error' ? 'kb-error' : 'kb-notice'} role={resourceState === 'access-error' ? 'alert' : 'status'}>
          <strong>{resourceState === 'access-error' ? 'Доступ к рейдам не подтверждён.' : 'Рейды пока не загрузились.'}</strong>
          <p>{resourceMessage}</p>
          <button className="kb-link-button" type="button" onClick={() => { setResourceState('loading'); void refresh() }}>Повторить</button>
        </div>
      )}

      {!current && upcoming.length > 1 && (
        <fieldset className="raid-choice">
          <legend>Какой рейд открыть?</legend>
          {upcoming.map((raid) => (
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
          <small>{confirmedRaidParticipants(selected).length} участников · версия {selected.version}</small>
        </div>
      )}

      {resourcePolicy.renderContent && !selected && (
        <RaidHomeCreatePrompt enabled={resourcePolicy.canMutate} kabanda={kabanda} />
      )}

      {primary && selected && (
        <button className="kb-primary raid-primary" type="button" onClick={primary.kind === 'refresh' ? refresh : openRaid}>
          {primary.label}
        </button>
      )}
    </section>
  )
}

export function RaidHomeCreatePrompt({
  enabled,
  kabanda,
}: {
  enabled: boolean
  kabanda: KabandaSummary
}) {
  if (!enabled) return null
  return <>
    <p className="kb-muted">Название и время — всё обязательное. Остальное можно решить в lobby.</p>
    <a
      className="kb-link-button kb-primary raid-primary"
      href={`${appPath('app')}?createRaid=${encodeURIComponent(kabanda.id)}`}
    >
      Создать рейд
    </a>
  </>
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
