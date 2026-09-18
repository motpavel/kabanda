import { appPath } from '../../lib/paths'
import { completionSummary } from './state'
import type { RaidResult } from './types'
import './raid-completion.css'

/** Used only after the lifecycle has confirmed completion. Null means that
 * the result metrics are still unknown, not that the ride is still active. */
export function RaidCompletionHero({ result }: { result: RaidResult | null }) {
  const metrics = result ? completionSummary(result) : [
    { id: 'duration', label: 'время рейда', value: '…' },
    { id: 'points', label: 'точек', value: '…' },
    { id: 'participants', label: 'участников', value: '…' },
    { id: 'distance', label: 'километров', value: '…' },
  ]
  return (
    <article className="raid-completion" aria-label="Рейд завершён. Отличная поездка!">
      <img className="raid-completion__art" src={appPath('brand/kabanda-raid-completed-v1.jpg')} width={1145} height={1374} alt="Рейд завершён! Отличная поездка! Кабанда празднует финиш над вечерним городом." />
      <dl className="raid-completion__stats" aria-label="Общая статистика рейда" aria-busy={!result}>
        {metrics.map((metric) => <div key={metric.id}><dt>{metric.label}</dt><dd aria-label={!result ? 'Данные ещё не получены' : undefined}>{metric.value}</dd></div>)}
      </dl>
    </article>
  )
}
