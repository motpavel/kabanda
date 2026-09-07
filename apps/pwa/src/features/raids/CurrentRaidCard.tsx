import { appPath } from '../../lib/paths'
import type { KabandaSummary } from '../kabandas/types'
import { freeHuntCoverUrl, routeRaidCoverUrl } from './FreeHuntCover'
import { confirmedRaidParticipants } from './production-model'
import { RaidHubIcon as Icon, type IconName } from './RaidHubIcon'
import { selectPrimaryAction } from './state'
import type { RaidProjection } from './types'
import './current-raid-card.css'

const stateLabels: Record<RaidProjection['state'], string> = {
  draft: 'Черновик', planned: 'Запланирован', lobby: 'Сбор открыт',
  active: 'Идёт сейчас', paused: 'На паузе', finalizing: 'Собираем итог',
  completed: 'Завершён', cancelled: 'Отменён',
}
const plural = new Intl.PluralRules('ru-RU')

export function currentRaidPresentation(raid: RaidProjection) {
  // Only split the old generated free-hunt title; never trim a rider's custom name.
  const generated = !raid.routeTemplateId && /^(?:Свободный рейд|Свободная охота)(?: · (\d{1,2} (?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)))?$/u.exec(raid.title.trim())
  const timestamp = raid.startedAt || raid.scheduledAt
  const validDate = timestamp && !Number.isNaN(Date.parse(timestamp)) ? timestamp : null
  return {
    title: generated ? 'Свободная охота' : raid.title,
    dateTime: validDate,
    date: validDate
      ? new Date(validDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
      : generated && generated[1] || null,
    startTime: validDate ? new Date(validDate).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—',
  }
}

/** The same current-ride card on Home and Raids, including its primary action. */
export function CurrentRaidCard({ kabanda, raid, stale, onRefresh, online = typeof navigator === 'undefined' || navigator.onLine }: {
  kabanda: KabandaSummary
  raid: RaidProjection
  stale: boolean
  onRefresh: () => void
  online?: boolean
}) {
  const primary = selectPrimaryAction(raid, { surface: 'home', online, stale })
  const label = primary?.label ?? 'Открыть рейд'
  const count = confirmedRaidParticipants(raid).length
  const participantLabel = ({ one: 'участник', few: 'участника', many: 'участников' } as Record<string, string>)[plural.select(count)] ?? 'участников'
  const presentation = currentRaidPresentation(raid)

  return <article className="kb-current-raid" data-testid="current-raid-card">
    <div className="kb-current-raid__top">
      <span className="kb-current-raid__status"><i aria-hidden="true" />{stateLabels[raid.state]}</span>
      <span className="kb-current-raid__team">{kabanda.name}</span>
    </div>
    <div className="kb-current-raid__intro">
      <img alt="" decoding="async" height="92" width="92" src={raid.routeTemplateId ? routeRaidCoverUrl : freeHuntCoverUrl} />
      <div>
        <h3 className="kb-current-raid__title">{presentation.title}</h3>
        {presentation.date && <time className="kb-current-raid__date" dateTime={presentation.dateTime ?? undefined}>{presentation.date}</time>}
        {raid.description?.trim() && <p className="kb-current-raid__description">{raid.description.trim()}</p>}
      </div>
    </div>
    <dl className="kb-current-raid__metrics">
      <Metric icon="clock" label="старт" value={presentation.startTime} />
      <Metric icon="group" label={participantLabel} value={String(count)} />
      <Metric icon="route" label="точек трека" value={raid.routeStatus.acceptedSampleCount.toLocaleString('ru-RU')} />
      <Metric icon="flag" label="навигатор" value={raid.navigatorUserId ? 'Назначен' : 'Не выбран'} text />
    </dl>
    {primary?.kind === 'refresh' ? (
      <button className="kb-current-raid__cta" onClick={onRefresh} type="button"><Icon name="clock" />{label}</button>
    ) : stale && !primary ? (
      <button className="kb-current-raid__cta" disabled type="button"><Icon name="clock" />Открыть после обновления</button>
    ) : (
      <a className="kb-current-raid__cta" href={`${appPath('app')}?raid=${encodeURIComponent(raid.id)}`}><Icon name="send" />{label}</a>
    )}
  </article>
}

function Metric({ icon, label, value, text = false }: { icon: IconName; label: string; value: string; text?: boolean }) {
  return <div className={`kb-current-raid__metric${text ? ' kb-current-raid__metric--text' : ''}`}><Icon name={icon} size={24} /><div><dt>{label}</dt><dd>{value}</dd></div></div>
}
