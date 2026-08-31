import { describe, expect, it } from 'vitest'
import { parseRaidsDesignScreen, parseRaidsDesignVariant, routeCards } from './model'

describe('raids design prototype model', () => {
  it('falls back to the approved hub state for unknown query values', () => {
    expect(parseRaidsDesignScreen('unknown')).toBe('hub')
    expect(parseRaidsDesignVariant('unknown')).toBe('active')
  })

  it('exposes preview and participant screens for the clickable handoff', () => {
    expect(parseRaidsDesignScreen('preview')).toBe('preview')
    expect(parseRaidsDesignScreen('participants')).toBe('participants')
  })

  it('keeps route cards complete enough for selection', () => {
    expect(routeCards).toHaveLength(3)
    for (const route of routeCards) {
      expect(route.title).not.toBe('')
      expect(route.description).not.toBe('')
      expect(route.points).toBeGreaterThan(0)
    }
  })
})
