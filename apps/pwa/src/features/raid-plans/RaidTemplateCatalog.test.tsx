import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RaidTemplateGrid } from './RaidTemplateCatalog'
import type { RaidTemplateSummary } from './types'

function template(id: string, title: string, createdAt: string): RaidTemplateSummary {
  return {
    id,
    kabandaId: 'kabanda-1',
    scope: 'kabanda',
    title,
    version: 1,
    cover: { url: `/api/raid-templates/${id}/cover`, sha256: 'sha', width: 1280, height: 720 },
    pointCount: 3,
    estimate: { method: 'straight_segments', distanceMeters: 4_200 },
    createdAt,
    updatedAt: createdAt,
  }
}

describe('raid template catalog', () => {
  it('keeps stale route previews visible without allowing a new raid from them', () => {
    const markup = renderToStaticMarkup(<RaidTemplateGrid disabled templates={[
      template('saved', 'Сохранённый маршрут', '2026-09-02T10:00:00.000Z'),
    ]} />)
    expect(markup).toContain('Сохранённый маршрут')
    expect(markup).toContain('aria-disabled="true"')
    expect(markup).not.toContain('href=')
  })

  it('keeps newly created routes below older cards without a details button', () => {
    const markup = renderToStaticMarkup(<RaidTemplateGrid templates={[
      template('new', 'Новый маршрут', '2026-09-02T10:00:00.000Z'),
      template('old', 'Старый маршрут', '2026-09-01T10:00:00.000Z'),
    ]} />)

    expect(markup.indexOf('Старый маршрут')).toBeLessThan(markup.indexOf('Новый маршрут'))
    expect(markup).toContain('4,2 км')
    expect(markup).toContain('Расстояние по прямым отрезкам')
    expect(markup).not.toContain('Веломаршрут')
    expect(markup).not.toContain('Подробнее')
    expect(markup.match(/class="prd-template-card"/g)).toHaveLength(2)
  })
})
