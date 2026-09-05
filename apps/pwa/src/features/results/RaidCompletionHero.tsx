import { appPath } from '../../lib/paths'
import { completionSummary } from './state'
import type { RaidResult } from './types'
import './raid-completion.css'

export function RaidCompletionHero({ result }: { result: RaidResult }) {
  return (
    <article className="raid-completion" aria-label="Рейд завершён. Отличная поездка!">
      <img
        className="raid-completion__art"
        src={appPath('brand/kabanda-raid-completed-v1.jpg')}
        width={1145}
        height={1374}
        alt="Рейд завершён! Отличная поездка! Кабанда празднует финиш над вечерним городом."
      />
      <dl className="raid-completion__stats" aria-label="Общая статистика рейда">
        {completionSummary(result).map((metric) => (
          <div key={metric.id}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
          </div>
        ))}
      </dl>
    </article>
  )
}
