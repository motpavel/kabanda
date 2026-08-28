import { describe, expect, it } from 'vitest'
import { parseRaidRoute } from './routing'

describe('raid deep-link routing', () => {
  it('restores an exact raid locator without treating it as a bearer', () => {
    expect(parseRaidRoute('?raid=11111111-1111-4111-8111-111111111111')).toEqual({
      kind: 'raid',
      raidId: '11111111-1111-4111-8111-111111111111',
    })
  })

  it('opens create only for an explicit Kabanda UUID', () => {
    expect(parseRaidRoute('?createRaid=22222222-2222-4222-8222-222222222222')).toEqual({
      kind: 'create',
      kabandaId: '22222222-2222-4222-8222-222222222222',
    })
  })

  it('rejects malformed locators before an API lookup', () => {
    expect(parseRaidRoute('?raid=../../private')).toEqual({ kind: 'invalid' })
    expect(parseRaidRoute('?createRaid=not-a-uuid')).toEqual({ kind: 'invalid' })
    expect(parseRaidRoute('?kabanda=22222222-2222-4222-8222-222222222222')).toEqual({ kind: 'home' })
  })
})
