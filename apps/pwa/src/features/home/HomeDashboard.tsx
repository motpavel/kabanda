import type { ReactNode } from 'react'
import { appPath } from '../../lib/paths'
import type { KabandaMember, KabandaSummary } from '../kabandas/types'
import { RaidHomeCard } from '../raids/RaidHomeCard'
import type { KabandaProgress } from '../results/types'
import './home.css'
import { HomeIcon } from './HomeIcon'

export function HomeDashboard({ identityId, kabanda, members, progress, notices }: {
  identityId: string
  kabanda: KabandaSummary
  members: KabandaMember[]
  progress: KabandaProgress | null
  notices?: ReactNode
}) {
  const destination = (tab: string) => `${appPath('app')}?kabanda=${encodeURIComponent(kabanda.id)}&tab=${tab}`
  const count = members.length || kabanda.memberCount
  const countLabel = new Intl.PluralRules('ru').select(count)
  const memberLabel = countLabel === 'one' ? 'участник' : countLabel === 'few' ? 'участника' : 'участников'
  const km = progress ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(progress.personal.distanceMeters / 1000) : '—'

  return <section className="kb-home" aria-label="Главная">
    <article className="kb-home-hero">
      <img src={appPath('brand/kabanda-home-ride-v2.jpg')} width="2048" height="768" alt="Кабаны на велосипедах над городом. Больше чем игра. Хорошие маршруты делают лучших людей." fetchPriority="high" decoding="async" />
      <div className="kb-home-hero-copy">
        <h1>Город — ваш<br />общий маршрут.</h1>
        <p>Знакомые лица. Новые места.<br />Ещё одна история вместе.</p>
      </div>
    </article>

    {notices}
    <div className="kb-home-layout">
      <div className="kb-home-next"><RaidHomeCard identityId={identityId} kabanda={kabanda} /></div>

      <section className="kb-home-team" aria-labelledby="home-team-heading">
        <div className="kb-home-section-heading"><h2 id="home-team-heading">Моя Кабанда</h2><a href={destination('kabanda')} aria-label="Открыть мою Кабанду"><HomeIcon name="arrow" /></a></div>
        <a className="kb-home-team-link" href={destination('kabanda')}>
          <img className="kb-home-team-cover" src={kabanda.coverImage ?? appPath('brand/kabanda-team-cover.jpg')} alt="" width="80" height="80" loading="lazy" />
          <div><h3>{kabanda.name}</h3><span>{count} {memberLabel} · {kabanda.role === 'owner' ? 'Вы вожак' : 'Вы участник'}</span></div>
        </a>
        {members.length > 0 && <div className="kb-home-crew">
          <div className="kb-home-avatars" aria-label="Состав Кабанды">{members.slice(0, 6).map(member => <span key={member.id} title={member.displayName}>{member.avatarUrl ? <img src={member.avatarUrl} alt={member.displayName} width="32" height="32" /> : <span aria-label={member.displayName}>{member.displayName.slice(0, 1).toUpperCase()}</span>}</span>)}</div>
          <a href={destination('kabanda')}>Вся стая <HomeIcon name="arrow" /></a>
        </div>}
      </section>

      <section className="kb-home-progress" aria-labelledby="home-progress-heading">
        <div className="kb-home-section-heading"><h2 id="home-progress-heading">Ваши приключения</h2><a href={destination('raids')}>История <HomeIcon name="arrow" /></a></div>
        <dl>
          <div><dt>рейдов</dt><dd>{progress?.personal.completedRaids ?? '—'}</dd></div>
          <div><dt>километров</dt><dd>{km}</dd></div>
          <div><dt>фото</dt><dd>{progress?.personal.photos ?? '—'}</dd></div>
        </dl>
        <p>{progress ? (progress.personal.completedRaids > 0 ? 'Ваш вклад в завершённые рейды этой Кабанды.' : 'Первый рейд станет началом вашей истории.') : 'Итоги появятся после загрузки данных.'}</p>
      </section>

      <a className="kb-home-explore" href={destination('map')}>
        <div><h2>Куда катим?</h2><p>Посмотрите точки города<br />и найдите следующий повод встретиться.</p><span>Открыть карту <HomeIcon name="arrow" /></span></div>
        <HomeIcon name="map" />
      </a>
    </div>
  </section>
}
