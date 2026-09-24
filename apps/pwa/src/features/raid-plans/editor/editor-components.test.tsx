import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DraftRaidTemplatePoint } from '../types'
import { RaidTemplatePointList } from './RaidTemplatePointList'
import { isPointSheetBackgroundTap, RaidTemplatePointSheet, shouldDismissPointSheet, shouldExpandPointSheet } from './RaidTemplatePointSheet'
import { RaidTemplateScopeControl } from './RaidTemplateEditorPage'

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
  it('allows confirmation without an address or geocoder and keeps the map outside the dialog', () => {
    const markup = renderToStaticMarkup(<RaidTemplatePointSheet
      point={{ ...points[0]!, address: '', geocodeStatus: 'failed', labelsConfirmed: false }} pointNumber={1}
      onClose={() => undefined} onConfirm={() => undefined} onDelete={() => undefined}
      onHeightChange={() => undefined} onUpdate={() => undefined}
    />)
    expect(markup).not.toContain('disabled')
    expect(markup).not.toContain('aria-modal="true"')
    expect(markup).toContain('Можно оставить пустым')
  })

  it('keeps a compact drag handle with keyboard instructions and editing on the row', () => {
    const markup = renderToStaticMarkup(<RaidTemplatePointList
      onMove={() => undefined}
      onReorder={() => undefined}
      onSelect={() => undefined}
      points={points}
      selectedPointId={null}
    />)
    expect(markup).toContain('Перетащить точку 1')
    expect(markup).not.toContain('Поднять точку')
    expect(markup).not.toContain('Удалить точку')
    expect(markup).toContain('Для изменения порядка с клавиатуры')
    expect(markup).toContain('Проверьте')
  })

  it('shows explicit provider attribution beside editable address labels', () => {
    const markup = renderToStaticMarkup(<RaidTemplatePointSheet
      onClose={() => undefined}
      onConfirm={() => undefined}
      onDelete={() => undefined}
      onHeightChange={() => undefined}
      onUpdate={() => undefined}
      point={points[1]!}
      pointNumber={2}
    />)
    expect(markup).toContain('© OpenStreetMap')
    expect(markup).toContain('https://www.openstreetmap.org/copyright')
    expect(markup).toContain('Подтвердить')
    expect(markup).toContain('rows="1"')
    expect(markup).not.toContain('Закрыть карточку точки')
    expect(markup).not.toContain('rt-point-sheet__close')
    expect(markup).toContain('Потяните вверх, чтобы развернуть, или вниз, чтобы закрыть')
    expect(markup).not.toContain('Сервис адресов предложил подписи')
  })

  it('dismisses only after a deliberate downward swipe', () => {
    expect(shouldDismissPointSheet(100, 171)).toBe(false)
    expect(shouldDismissPointSheet(100, 172)).toBe(true)
    expect(shouldDismissPointSheet(100, 40)).toBe(false)
  })

  it('expands upward while keeping small drags and downward swipes distinct', () => {
    expect(shouldExpandPointSheet(200, 153)).toBe(false)
    expect(shouldExpandPointSheet(200, 152)).toBe(true)
    expect(shouldExpandPointSheet(200, 272)).toBe(false)
  })

  it('closes on short background taps without treating map pans or long presses as taps', () => {
    expect(isPointSheetBackgroundTap(8, 500)).toBe(true)
    expect(isPointSheetBackgroundTap(9, 100)).toBe(false)
    expect(isPointSheetBackgroundTap(0, 501)).toBe(false)
    expect(isPointSheetBackgroundTap(0, -1)).toBe(false)
  })
})

describe('raid template access control', () => {
  it('defaults to the Kabanda and explains the public disclosure before saving', () => {
    const privateMarkup = renderToStaticMarkup(<RaidTemplateScopeControl
      kabandaName="Кабанда Preview"
      onChange={() => undefined}
      scope="kabanda"
    />)
    const publicMarkup = renderToStaticMarkup(<RaidTemplateScopeControl
      kabandaName="Кабанда Preview"
      onChange={() => undefined}
      scope="all_authenticated"
    />)

    expect(privateMarkup).toContain('Только для своих')
    expect(privateMarkup).toContain('Для всех')
    expect(privateMarkup).toContain('Маршрут увидят только участники вашей Кабанды')
    expect(privateMarkup).toMatch(/type="radio"[^>]*checked=""/)
    expect(publicMarkup).toContain('Обложку, комментарии и координаты увидят все участники приложения')
  })
})
