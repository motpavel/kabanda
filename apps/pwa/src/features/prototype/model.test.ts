import { describe, expect, it } from 'vitest'
import {
  deliveryStateCopy,
  flows,
  getAdjacentScreen,
  getPrimaryLabel,
  getPrimaryTarget,
} from './model'

describe('VP UX prototype graph', () => {
  it('keeps every flow inside the declared screen registry with one primary action', () => {
    for (const [role, flow] of Object.entries(flows)) {
      expect(new Set(flow).size).toBe(flow.length)
      for (const screenId of flow) {
        expect(getPrimaryLabel(role as keyof typeof flows, screenId).trim()).not.toBe('')
      }
    }
  })

  it('covers the critical ride and recovery states for both roles', () => {
    for (const flow of Object.values(flows)) {
      expect(flow).toContain('lobby')
      expect(flow).toContain('active')
      expect(flow).toContain('checkin')
      expect(flow).toContain('offline')
      expect(flow).toContain('result')
      expect(flow).toContain('map')
      expect(flow).toContain('profile')
    }
    expect(flows.organizer).toContain('finish')
    expect(flows.organizer).toContain('auth')
    expect(flows.participant).not.toContain('finish')
    expect(flows.participant).toContain('auth')
  })

  it('does not advance beyond either edge of a flow', () => {
    expect(getAdjacentScreen('organizer', 'entry', -1)).toBe('entry')
    expect(getAdjacentScreen('organizer', 'profile', 1)).toBe('profile')
  })

  it('keeps every primary transition inside the selected role flow', () => {
    for (const [role, flow] of Object.entries(flows)) {
      for (const screen of flow) {
        expect(flow).toContain(getPrimaryTarget(role as keyof typeof flows, screen))
      }
    }
  })

  it('never starts a raid-scoped check-in from the global map', () => {
    for (const role of Object.keys(flows) as Array<keyof typeof flows>) {
      expect(getPrimaryTarget(role, 'map')).toBe('point-detail')
      expect(getPrimaryTarget(role, 'point-detail')).toBe('map')
    }
  })

  it('uses four distinct canonical delivery labels', () => {
    expect(new Set(Object.values(deliveryStateCopy))).toEqual(
      new Set(['Сохранено на телефоне', 'Отправляем', 'Принято Кабандой', 'Нужно действие']),
    )
  })
})
