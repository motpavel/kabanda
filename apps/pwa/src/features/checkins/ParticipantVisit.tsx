import { CachedImage } from '../../lib/CachedImage'
import type { RaidMapPoint, RaidProjection } from '../raids/types'
import './participant-visit.css'

export function ParticipantVisit({ identityId, raid, point }: { identityId: string; raid: RaidProjection; point: RaidMapPoint }) {
  const marked = new Set(point.lastVisitParticipantIds ?? [])
  const members = raid.participants.filter(member => member.state === 'active' || marked.has(member.id))
  const time = point.lastVisitedAt ? new Date(point.lastVisitedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null
  return <section className="participant-visit" aria-label="Отметка команды">
    <p className={`participant-visit__status${marked.has(identityId) ? ' participant-visit__status--marked' : ''}`}>
      {point.lastAttemptId ? marked.has(identityId) ? 'Вы отмечены' : 'Вас нет в последней отметке' : 'Ждём отметку навигатора'}{time && <span> · {time}</span>}
    </p>
    {point.lastAttemptId && <><h3>На этой остановке</h3><ul>{members.map(member => <li key={member.id}>
      <span className="checkin-participant__avatar" aria-hidden="true">{member.avatarUrl ? <CachedImage identityId={identityId} src={member.avatarUrl} alt="" /> : member.displayName.trim().slice(0, 1).toUpperCase()}</span>
      <span className="participant-visit__name">{member.displayName}<small>{member.id === identityId ? 'Вы' : member.id === raid.navigatorUserId ? 'Навигатор' : ''}</small></span>
      <span className={`participant-visit__mark${marked.has(member.id) ? ' is-marked' : ''}`}><span aria-hidden="true">{marked.has(member.id) ? '✓' : '—'}</span>{marked.has(member.id) ? 'Отмечен' : 'Не отмечен'}</span>
    </li>)}</ul></>}
  </section>
}
