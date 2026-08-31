import { describe, expect, it } from 'vitest'
import {
  longParticipantList,
  parseParticipantDesignState,
  parseRaidsDesignScreen,
  parseRaidsDesignVariant,
  routeCards,
} from './model'

describe('raids design prototype model', () => {
  it('falls back to the approved hub state for unknown query values', () => {
    expect(parseRaidsDesignScreen('unknown')).toBe('hub')
    expect(parseRaidsDesignVariant('unknown')).toBe('active')
  })

  it('exposes preview and participant screens for the clickable handoff', () => {
    expect(parseRaidsDesignScreen('preview')).toBe('preview')
    expect(parseRaidsDesignScreen('schedule')).toBe('schedule')
    expect(parseRaidsDesignScreen('participants')).toBe('participants')
    expect(parseRaidsDesignVariant('upcoming-cases')).toBe('upcoming-cases')
  })

  it('keeps route cards complete enough for selection', () => {
    expect(routeCards).toHaveLength(3)
    for (const route of routeCards) {
      expect(route.title).not.toBe('')
      expect(route.description).not.toBe('')
      expect(route.points).toBeGreaterThan(0)
    }
  })

  it('covers the 20-person alpha limit and disabled-member design state', () => {
    expect(longParticipantList).toHaveLength(20)
    expect(longParticipantList.some((participant) => participant.disabled)).toBe(true)
    expect(parseParticipantDesignState('long')).toBe('long')
    expect(parseParticipantDesignState('unknown')).toBe('default')
  })
})
