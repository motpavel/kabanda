import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@kabanda/contracts/exploration'
import { ProductionHistory } from './PagedRaidHistory'
import { formatDistance } from './state'

const zero = { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0 }
const raid: HistoryEntry = {
  raidId: '44444444-4444-4444-8444-444444444444', title: 'Вечерняя поездка',
  completedAt: '2026-09-18T12:00:00Z', partial: false, participated: true,
  team: { ...zero, distanceMeters: 3000 }, personal: zero,
}
const coverImage = '/synthetic-cover.jpg'

describe('paged history presentation', () => {
  it('keeps a confirmed zero-metric participant in the supplied mine history', () => {
    const markup = renderToStaticMarkup(<ProductionHistory coverImage={coverImage} history={[raid]} filter="mine" />)
    expect(markup).toContain(raid.title)
    expect(markup).toContain('aria-label="Личный результат"')
    expect(markup).toContain(formatDistance(0))
    expect(markup).not.toContain('Не участвовали')
    expect(markup).not.toContain('Ваш первый результат ещё впереди')
  })

  it('does not present a nonparticipant as a rider with zero kilometres', () => {
    const markup = renderToStaticMarkup(<ProductionHistory coverImage={coverImage} history={[{ ...raid, participated: false }]} />)
    expect(markup).toContain('aria-label="Без личного участия"')
    expect(markup).toContain('Не участвовали')
    expect(markup).not.toContain('aria-label="Личный результат"')
    expect(markup).toContain(formatDistance(3000))
  })

  it('hides previously supplied private rows and the cover after access denial', () => {
    const markup = renderToStaticMarkup(<ProductionHistory coverImage={coverImage} history={[raid]} status="access-error" onRetry={() => undefined} />)
    expect(markup).not.toContain(raid.title)
    expect(markup).not.toContain(coverImage)
    expect(markup).toContain('Доступ к истории не подтверждён')
    expect(markup).not.toContain('Первый финиш ещё впереди')
    expect(markup).toContain('Повторить загрузку')
  })

  it('keeps known rows when another page fails and offers a retry', () => {
    const markup = renderToStaticMarkup(<ProductionHistory coverImage={coverImage} history={[raid]} status="stale" message="Не удалось обновить данные." hasMore onMore={() => undefined} onRetry={() => undefined} />)
    expect(markup).toContain(raid.title)
    expect(markup).toContain('Повторить загрузку')
    expect(markup).toContain('Показать ещё')
    expect(markup).toContain('disabled=""')
    expect(markup).not.toContain('Первый финиш ещё впереди')
  })

  it('does not replace loading or a failed first page with an empty achievement state', () => {
    for (const status of ['loading', 'error'] as const) {
      const markup = renderToStaticMarkup(<ProductionHistory coverImage={coverImage} history={null} status={status} />)
      expect(markup).not.toContain('Первый финиш ещё впереди')
      expect(markup).not.toContain('Показано рейдов: 0')
    }
  })
})
