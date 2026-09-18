import { useEffect, useState } from 'react'
import { navigateApp } from '../../app/transitions'
import { useActionableRaids } from './resources'
import { appPath } from '../../lib/paths'
import { HomeIcon } from '../home/HomeIcon'
import type { KabandaSummary } from '../kabandas/types'
import { CurrentRaidCard } from './CurrentRaidCard'
import { confirmedRaidParticipants, productionResourcePolicy, splitActionableRaids } from './production-model'
import { selectPrimaryAction } from './state'
import type { RaidProjection } from './types'
import './raids.css'

export function RaidHomeCard({
  identityId,
  kabanda,
  active = true,
}: {
  identityId: string
  kabanda: KabandaSummary
  active?: boolean
}) {
  const resource = useActionableRaids(identityId, kabanda.id, active)
  const actionable = resource.data ?? []
  const resourceState = resource.status
  const resourceMessage = resource.message
  const stale = resourceState !== 'ready'
  const refresh = resource.refresh
  const [selectedId, setSelectedId] = useState<string | null>(null)
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

  const { current, upcoming, invitations } = splitActionableRaids(actionable, identityId)
  const resourcePolicy = productionResourcePolicy(resourceState, online)
  const selected =
    current ??
    upcoming.find(({ id }) => id === selectedId) ??
    upcoming[0] ?? null
  const primary = selected
    ? selectPrimaryAction(selected, {
        surface: 'home',
        online,
        stale,
      })
    : null

  const openRaid = () => {
    if (!selected) return
    navigateApp(`${appPath('app')}?raid=${encodeURIComponent(selected.id)}`)
  }

  return (
    <section className={current ? 'raid-home-current' : 'kb-card raid-home-card'} aria-busy={resourceState === 'loading'}>
      <div className="kb-home-section-heading">
        <h2>{current ? 'Сейчас' : 'Ближайшие рейды'}</h2>
        <a href={`${appPath('app')}?kabanda=${encodeURIComponent(kabanda.id)}&tab=raids`}>Все <HomeIcon name="arrow" /></a>
      </div>

      {resourceState === 'loading' && <p className="kb-muted">Проверяем, что сейчас важно…</p>}


      {resourceState === 'stale' && resourceMessage && <p role="status" className="kb-muted">{resourceMessage}</p>}

      {(resourceState === 'access-error' || resourceState === 'error') && (
        <div className={resourceState === 'access-error' ? 'kb-error' : 'kb-notice'} role={resourceState === 'access-error' ? 'alert' : 'status'}>
          <strong>{resourceState === 'access-error' ? 'Доступ к рейдам не подтверждён.' : 'Рейды пока не загрузились.'}</strong>
          <p>{resourceMessage}</p>
          <button className="kb-link-button" type="button" onClick={() => { void refresh() }}>Повторить</button>
        </div>
      )}

      {invitations.length > 0 && <a className="kb-home-invitation" href={`${appPath('app')}?raid=${encodeURIComponent(invitations[0]!.id)}`}>
        <HomeIcon name="calendar" /><span>{stale ? 'Сохранённое приглашение' : 'Вас ждут в рейде'}<strong>{invitations[0]!.title}</strong></span><HomeIcon name="arrow" />
      </a>}

      {!current && upcoming.length > 1 && (
        <div className="kb-home-raid-options" aria-label="Ближайшие рейды">
          {upcoming.slice(0, 3).map((raid) => (
            <button
              key={raid.id}
              type="button"
              aria-pressed={selected?.id === raid.id}
              onClick={() => setSelectedId(raid.id)}
            >
              <HomeIcon name="calendar" /><span><strong>{raid.title}</strong><small>{scheduleLabel(raid.scheduledAt)}</small></span>
            </button>
          ))}
        </div>
      )}

      {current && <CurrentRaidCard kabanda={kabanda} raid={current} stale={stale} online={online} onRefresh={() => void refresh()} />}

      {selected && !current && (
        <div className="kb-home-raid-summary">
          <span className="kb-home-raid-status">{stale ? (online ? 'Проверяем состояние…' : 'Сохранённый рейд') : stateLabel(selected.state)}</span>
          <h3>{selected.title}</h3>
          <p>{scheduleLabel(selected.scheduledAt)} · {confirmedRaidParticipants(selected).length} участников</p>
          {selected.description && <p className="kb-home-raid-description">{selected.description}</p>}
          {selected.kabandaId !== kabanda.id && <small>Активный рейд другой Кабанды</small>}
        </div>
      )}

      {resourcePolicy.renderContent && !selected && <div className="kb-home-no-raid">
        <HomeIcon name="bike" /><h3>Соберёмся на прогулку?</h3>
        <p>{invitations.length ? 'Ответьте на приглашение или запланируйте свою поездку.' : 'Ближайших поездок пока нет. Выберите время — и позовите своих.'}</p>
        <RaidHomeCreatePrompt enabled={resourcePolicy.canMutate} kabanda={kabanda} />
        {!resourcePolicy.canMutate && <p>Создание рейда доступно после подключения к сети и обновления.</p>}
      </div>}

      {primary && selected && !current && (
        <button className="kb-primary raid-primary" type="button" onClick={primary.kind === 'refresh' ? () => void refresh() : openRaid}>
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
    <a
      className="kb-link-button kb-primary raid-primary"
      href={`${appPath('app')}?createRaid=${encodeURIComponent(kabanda.id)}`}
    >
      <HomeIcon name="plus" /> Создать рейд
    </a>
  </>
}

function stateLabel(state: RaidProjection['state']): string {
  return {
    draft: 'Черновик',
    planned: 'Запланирован',
    lobby: 'Сбор команды',
    active: 'В пути',
    paused: 'Пауза',
    finalizing: 'Собираем итог',
    completed: 'Завершён',
    cancelled: 'Отменён',
  }[state]
}

function scheduleLabel(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Старт после сбора'
}
