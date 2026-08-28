import { describe, expect, it } from 'vitest'
import { deliveryStateCopy, flows, getAdjacentScreen, screens } from './model'

describe('VP UX prototype graph', () => {
  it('keeps every flow inside the declared screen registry with one primary action', () => {
    for (const flow of Object.values(flows)) {
      expect(new Set(flow).size).toBe(flow.length)
      for (const screenId of flow) {
        expect(screens[screenId].primaryLabel.trim()).not.toBe('')
      }
    }
  })

  it('covers the critical ride and recovery states for both roles', () => {
    for (const flow of Object.values(flows)) {
      expect(flow).toContain('lobby')
      expect(flow).toContain('active')
      expect(flow).toContain('checkin')
      expect(flow).toContain('offline')
      expect(flow).toContain('finish')
      expect(flow).toContain('result')
    }
  })

  it('does not advance beyond either edge of a flow', () => {
    expect(getAdjacentScreen('organizer', 'entry', -1)).toBe('entry')
    expect(getAdjacentScreen('organizer', 'history', 1)).toBe('history')
  })

  it('uses four distinct canonical delivery labels', () => {
    expect(new Set(Object.values(deliveryStateCopy))).toEqual(
      new Set(['Сохранено на телефоне', 'Отправляем', 'Принято Кабандой', 'Нужно действие']),
    )
  })
})
