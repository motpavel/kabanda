import { useRef } from 'react'
import { appPath } from '../../lib/paths'
import { useRaidHistory, useKabandaProgress } from '../raids/resources'
import { formatDistance } from './state'

export function RaidHistory({ identityId, kabandaId }: { identityId: string; kabandaId: string }) {
  const listRef = useRef<HTMLDivElement>(null)
  const history = useRaidHistory(identityId, kabandaId)
  const stats = useKabandaProgress(identityId, kabandaId)
  const raids = history.data?.raids ?? []
  const progress = stats.data
  const staleAt = history.savedAt ?? stats.savedAt
  const loading = history.status === 'loading'

  return (
    <section className="kb-card result-history">
      <div className="kb-section-head"><div><h2>История рейдов</h2><p>Канонические итоги завершённых поездок.</p></div>{raids.length > 1 && <div className="result-history__controls" aria-label="Прокрутка истории"><button type="button" aria-label="Предыдущие рейды" onClick={() => listRef.current?.scrollBy({ left: -280, behavior: 'smooth' })}>←</button><button type="button" aria-label="Следующие рейды" onClick={() => listRef.current?.scrollBy({ left: 280, behavior: 'smooth' })}>→</button></div>}</div>
      {staleAt && <p className="kb-stale">Сохранённая копия от {new Date(staleAt).toLocaleString('ru-RU')} — только для этого аккаунта.</p>}
      {progress && <div className="result-progress"><div><span>Лично</span><strong>{progress.personal.completedRaids} рейдов</strong><small>{formatDistance(progress.personal.distanceMeters)} · {progress.personal.uniquePoints} точек</small></div><div><span>Команда</span><strong>{progress.team.completedRaids} рейдов</strong><small>{formatDistance(progress.team.distanceMeters)} · {progress.team.uniquePoints} точек</small></div></div>}
      {loading && <p className="kb-muted" aria-busy="true">Загружаем последние результаты…</p>}
      {!loading && raids.length === 0 && <p className="kb-muted">Завершённых рейдов пока нет.</p>}
      <div className="result-history__list" ref={listRef}>{raids.slice(0, 12).map((raid) => (
        <a key={raid.raidId} href={`${appPath('app')}?raid=${encodeURIComponent(raid.raidId)}`}>
          <span><small>{new Date(raid.completedAt).toLocaleDateString('ru-RU')}{raid.partial ? ' · partial' : ''}</small><strong>{raid.title}</strong></span>
          <span>{formatDistance(raid.team.distanceMeters)} · {raid.team.uniquePoints} точек · {raid.team.photos} фото</span>
        </a>
      ))}</div>
    </section>
  )
}
