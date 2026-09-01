import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DraftRaidTemplatePoint } from '../types'
import { RaidTemplatePointList } from './RaidTemplatePointList'
import { RaidTemplatePointSheet } from './RaidTemplatePointSheet'

const points: DraftRaidTemplatePoint[] = [
  {
    clientId: 'first', name: 'Старт', address: 'Пушкинская, 1', comment: '', latitude: 56.8, longitude: 53.2,
    geocodeStatus: 'ready', geocodeRequestId: null, labelsConfirmed: true,
  },
  {
    clientId: 'second', name: 'Финиш', address: 'Береговая, 2', comment: 'Встречаемся у входа', latitude: 56.9, longitude: 53.3,
    geocodeStatus: 'ready', geocodeRequestId: null, labelsConfirmed: false,
  },
]

describe('raid template point controls', () => {
  it('keeps drag, move buttons, and edit cards available together', () => {
    const markup = renderToStaticMarkup(<RaidTemplatePointList
      onDelete={() => undefined}
      onMove={() => undefined}
      onReorder={() => undefined}
      onSelect={() => undefined}
      points={points}
      selectedPointId={null}
    />)
    expect(markup).toContain('Перетащить точку 1')
    expect(markup).toContain('Поднять точку 2 выше')
    expect(markup).toContain('Опустить точку 1 ниже')
    expect(markup).toContain('Проверьте')
  })

  it('shows explicit provider attribution beside editable address labels', () => {
    const markup = renderToStaticMarkup(<RaidTemplatePointSheet
      onClose={() => undefined}
      onConfirm={() => undefined}
      onDelete={() => undefined}
      onRetryGeocode={() => undefined}
      onUpdate={() => undefined}
      point={points[1]!}
      pointNumber={2}
    />)
    expect(markup).toContain('Адреса © OpenStreetMap contributors')
    expect(markup).toContain('https://www.openstreetmap.org/copyright')
    expect(markup).toContain('Подтвердить название и адрес')
  })
})
