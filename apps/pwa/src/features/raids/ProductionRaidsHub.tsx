import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../lib/http'
import { appPath } from '../../lib/paths'
import { useActionableRaids } from './resources'
import { CurrentRaidCard } from './CurrentRaidCard'
import { RaidHubIcon as Icon } from './RaidHubIcon'
import type { KabandaSummary } from '../kabandas/types'
import { PagedRaidHistory } from '../results/PagedRaidHistory'
export { ProductionHistory } from '../results/PagedRaidHistory'
import { sendParticipantCommand } from './api'
import {
  confirmedRaidParticipants,
  participationLabel,
  ProductionRefreshFence,
  productionResourcePolicy,
  splitActionableRaids,
} from './production-model'
import { isStaleConflict } from './state'
import type { RaidProjection } from './types'
import { RaidTemplateCatalog } from '../raid-plans/RaidTemplateCatalog'
import '../raids-design/raids-design.css'
import './production-raids.css'

type InvitationCommand = 'accept' | 'decline'
type InvitationOperation = { raidId: string; command: InvitationCommand }
type InvitationNotice = { tone: 'success' | 'error'; text: string }

export function ProductionRaidsHub({
  identityId,
  kabanda,
  active = true,
}: {
  identityId: string
  kabanda: KabandaSummary
  active?: boolean
}) {
  const resource = useActionableRaids(identityId, kabanda.id, kabanda.role, active)
  const actionable = resource.data ?? []
  const resourceState = resource.status
  const resourceMessage = resource.message
  const refresh = resource.refresh
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const [invitationOperation, setInvitationOperation] = useState<InvitationOperation | null>(null)
  const [invitationNotice, setInvitationNotice] = useState<InvitationNotice | null>(null)
  const refreshFence = useRef(new ProductionRefreshFence())
  const invitationKeys = useRef(new Map<string, string>())
  useEffect(() => {
    const updateConnection = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateConnection)
    window.addEventListener('offline', updateConnection)
    return () => {
      window.removeEventListener('online', updateConnection)
      window.removeEventListener('offline', updateConnection)
    }
  }, [])

  const respondToInvitation = useCallback(async (raid: RaidProjection, command: InvitationCommand) => {
    if (resourceState !== 'ready' || !online || !refreshFence.current.beginMutation()) {
      if (!online) setInvitationNotice({ tone: 'error', text: 'Для ответа на приглашение нужно подключение к интернету.' })
      return
    }

    const logical = `${raid.id}:${command}:${raid.version}`
    const idempotencyKey = invitationKeys.current.get(logical) ?? crypto.randomUUID()
    invitationKeys.current.set(logical, idempotencyKey)
    setInvitationOperation({ raidId: raid.id, command })
    setInvitationNotice(null)
    let refreshAfterMutation = false

    try {
      await sendParticipantCommand(raid.id, command, raid.version, idempotencyKey)
      invitationKeys.current.delete(logical)
      setInvitationNotice({
        tone: 'success',
        text: command === 'accept'
          ? `Вы участвуете в рейде «${raid.title}». Он появился в предстоящих.`
          : `Приглашение в рейд «${raid.title}» отклонено.`,
      })
    } catch (error) {
      if (error instanceof ApiError && isStaleConflict(error.status, error.code)) {
        invitationKeys.current.delete(logical)
        setInvitationNotice({ tone: 'error', text: 'Состав рейда изменился. Обновили список — нажмите ещё раз, чтобы отправить свой ответ.' })
        refreshAfterMutation = true
      } else if (error instanceof ApiError) {
        setInvitationNotice({ tone: 'error', text: error.message })
        if (error.status === 401 || error.status === 403 || error.status === 404 || (error.status === 409 && error.code !== 'IDEMPOTENCY_CONFLICT')) {
          invitationKeys.current.delete(logical)
          refreshAfterMutation = true
        }
      } else {
        setInvitationNotice({ tone: 'error', text: 'Ответ не отправлен. Когда связь восстановится, повтор использует тот же ключ действия.' })
      }
    } finally {
      refreshFence.current.finishMutation()
      setInvitationOperation(null)
      if (refreshAfterMutation) await refresh()
    }
  }, [identityId, online, refresh, resourceState])

  const { current, invitations, upcoming } = useMemo(
    () => splitActionableRaids(actionable, identityId),
    [actionable, identityId],
  )
  const coverImage = kabanda.coverImage ?? appPath('brand/kabanda-team-cover.jpg')
  const resourcePolicy = productionResourcePolicy(resourceState, online)
  const canMutate = resourcePolicy.canMutate

  return (
    <section className="prd-raids" data-testid="production-raids-hub" aria-busy={resourceState === 'loading'} aria-label="Рейды Кабанды">
      <header className="rdp-heading prd-raids__heading">
        <h1>Рейды</h1>
        <ProductionCreateActions enabled={canMutate} kabandaId={kabanda.id} reason={!online ? 'Для создания понадобится интернет.' : resourceState === 'loading' || resourceState === 'stale' ? 'Проверяем доступ к созданию.' : 'Доступ не подтверждён. Обновите данные.'} />
      </header>
      {resourceState === 'stale' && resourceMessage && <p role="status">{resourceMessage}</p>}
      {invitationNotice && (
        <p className={`prd-raids__notice prd-raids__notice--${invitationNotice.tone}`} role={invitationNotice.tone === 'error' ? 'alert' : 'status'}>
          <Icon name={invitationNotice.tone === 'success' ? 'check' : 'clock'} size={19} />
          {invitationNotice.text}
        </p>
      )}
      {resourceState === 'loading' ? <ProductionLoading /> : resourceState === 'access-error' || resourceState === 'error' ? (
        <ProductionResourceError accessDenied={resourceState === 'access-error'} message={resourceMessage ?? 'Не удалось загрузить рейды.'} onRetry={() => { void refresh() }} />
      ) : (
        <>
          {current && (
            <section className="rdp-section" aria-labelledby="production-now-heading" data-testid="production-current-raid">
              <h2 id="production-now-heading">Сейчас</h2>
              <CurrentRaidCard kabanda={kabanda} raid={current} stale={resourceState === 'stale'} onRefresh={() => void refresh()} />
            </section>
          )}
          {invitations.length > 0 && (
            <section className="rdp-section prd-invitations" aria-labelledby="production-invitations-heading" data-testid="production-raid-invitations">
              <div className="prd-section-heading">
                <div><h2 id="production-invitations-heading">Приглашения</h2><p>Ответьте сейчас — рейд появится в предстоящих только после принятия.</p></div>
                <span>{invitations.length}</span>
              </div>
              {!online && <p className="prd-invitations__offline" role="status">Для ответа понадобится интернет. Открыть детали можно и сейчас.</p>}
              <div className="prd-invitations__list">
                {invitations.map((raid) => (
                  <InvitationRaidRow busyCommand={invitationOperation?.raidId === raid.id ? invitationOperation.command : null}
                    disabled={!canMutate || Boolean(invitationOperation)} key={raid.id}
                    onRespond={(command) => void respondToInvitation(raid, command)} raid={raid} />
                ))}
              </div>
            </section>
          )}
          {upcoming.length > 0 && (
            <section className="rdp-section" aria-labelledby="production-upcoming-heading" data-testid="production-upcoming-raids">
              <h2 id="production-upcoming-heading">Предстоящие</h2>
              <div className="rdp-list-card">
                {upcoming.map((raid) => <UpcomingRaidRow identityId={identityId} key={raid.id} raid={raid} stale={resourceState !== 'ready'} />)}
              </div>
            </section>
          )}
        </>
      )}
      {resourceState !== 'access-error' && <RaidTemplateCatalog identityId={identityId} kabandaId={kabanda.id} active={active} />}
      {resourceState !== 'access-error' && <PagedRaidHistory identityId={identityId} kabandaId={kabanda.id} coverImage={coverImage} active={active} />}
    </section>
  )
}

export function ProductionCreateActions({ enabled, kabandaId, reason = 'Доступ не подтверждён. Обновите данные.' }: { enabled: boolean; kabandaId: string; reason?: string }) {
  return <nav aria-label="Создание рейда и маршрута" className="prd-raids__create-actions">
    <a className="rdp-new prd-raids__new" data-testid="production-new-raid" role="link"
      aria-disabled={!enabled || undefined} tabIndex={enabled ? undefined : 0} title={enabled ? undefined : reason}
      href={enabled ? `${appPath('app')}?createRaid=${encodeURIComponent(kabandaId)}` : undefined}>
      Выйти в рейд
    </a>
    <a className="rdp-new prd-raids__new prd-raids__new--template" data-testid="production-new-template" role="link"
      aria-disabled={!enabled || undefined} tabIndex={enabled ? undefined : 0} title={enabled ? undefined : reason}
      href={enabled ? `${appPath('app')}?createRaidTemplate=${encodeURIComponent(kabandaId)}` : undefined}>
      <Icon name="route" size={18} /> Новый маршрут
    </a>
  </nav>
}

function ProductionResourceError({ accessDenied, message, onRetry }: { accessDenied: boolean; message: string; onRetry: () => void }) {
  return <section className="prd-resource-error" role={accessDenied ? 'alert' : 'status'}>
    <span><Icon name={accessDenied ? 'close' : 'clock'} /></span>
    <div><strong>{accessDenied ? 'Доступ к рейдам не подтверждён' : 'Рейды пока не загрузились'}</strong><p>{message}</p><button type="button" onClick={onRetry}>Повторить</button></div>
  </section>
}

export function InvitationRaidRow({ busyCommand, disabled, onRespond, raid }: {
  busyCommand: InvitationCommand | null; disabled: boolean; onRespond: (command: InvitationCommand) => void; raid: RaidProjection
}) {
  const canAccept = raid.allowedActions.includes('accept')
  const canDecline = raid.allowedActions.includes('decline')
  const participants = confirmedRaidParticipants(raid)
  const avatars = participants.slice(0, 3)
  return <article className="prd-invitation" aria-busy={Boolean(busyCommand)}>
    <div className="prd-invitation__summary">
      <span className="prd-invitation__icon"><Icon name="calendar" /></span>
      <span className="prd-invitation__copy"><a href={`${appPath('app')}?raid=${encodeURIComponent(raid.id)}`}>{raid.title}</a><small>{formatSchedule(raid.scheduledAt)}</small></span>
      {avatars.length > 0 && <span aria-label={`${participants.length} подтверждённых участников`} className="rdp-row__avatars prd-invitation__avatars">
        {avatars.map((participant) => <i aria-hidden="true" key={participant.id}>{initial(participant.displayName)}</i>)}
      </span>}
    </div>
    {raid.description?.trim() && <p className="prd-invitation__description">{raid.description}</p>}
    <div className="prd-invitation__actions">
      <button className="prd-invitation__accept" disabled={disabled || !canAccept} onClick={() => onRespond('accept')} type="button">
        <Icon name="check" size={19} />{busyCommand === 'accept' ? 'Принимаем…' : 'Принять'}
      </button>
      <button className="prd-invitation__decline" disabled={disabled || !canDecline} onClick={() => onRespond('decline')} type="button">
        <Icon name="close" size={19} />{busyCommand === 'decline' ? 'Отказываемся…' : 'Отказаться'}
      </button>
    </div>
  </article>
}

function ProductionLoading() {
  return <div className="rdp-loading prd-raids__loading" aria-label="Загружаем рейды"><i /><i /><i /></div>
}

function UpcomingRaidRow({ identityId, raid, stale }: { identityId: string; raid: RaidProjection; stale: boolean }) {
  const participants = confirmedRaidParticipants(raid)
  const avatars = participants.slice(0, 3)
  return <a aria-label={`Открыть рейд: ${raid.title}`} className="rdp-row" href={`${appPath('app')}?raid=${encodeURIComponent(raid.id)}`}>
    <span className="rdp-row__icon"><Icon name="calendar" /></span>
    <span className="rdp-row__copy">
      <strong>{raid.title}</strong>
      <small><span>{formatSchedule(raid.scheduledAt)}</span>{avatars.length > 0 && <span aria-label={`${participants.length} подтверждённых участников`} className="rdp-row__avatars">{avatars.map((participant) => <i aria-hidden="true" key={participant.id}>{initial(participant.displayName)}</i>)}</span>}</small>
    </span>
    <span className="rdp-row__action"><span className="rdp-row__badge">{stale ? 'Уточняем статус' : participationLabel(raid, identityId)}</span><Icon name="chevron" size={19} /></span>
  </a>
}

function formatSchedule(value: string | null): string {
  if (!value) return 'Старт после сбора'
  return new Date(value).toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
function initial(value: string): string { return value.trim().slice(0, 1).toUpperCase() || '•' }
