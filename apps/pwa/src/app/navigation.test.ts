import { describe, expect, it } from 'vitest'
import { appSectionSearch, parseAppSection, resolveSelectedKabandaId } from './navigation'

describe('app section navigation', () => {
  it('defaults invalid and missing sections to home', () => {
    expect(parseAppSection('')).toBe('home')
    expect(parseAppSection('?tab=unknown')).toBe('home')
  })

  it('reads every permanent app section', () => {
    expect(parseAppSection('?tab=map')).toBe('map')
    expect(parseAppSection('?tab=raids')).toBe('raids')
    expect(parseAppSection('?tab=kabanda')).toBe('kabanda')
  })

  it('keeps the selected Kabanda and removes temporary raid routes', () => {
    expect(appSectionSearch('?raid=raid-id&kabanda=old', 'map', 'team-id')).toBe(
      '?kabanda=team-id&tab=map',
    )
    expect(appSectionSearch('?createRaid=team-id&tab=raids', 'home', 'team-id')).toBe(
      '?kabanda=team-id',
    )
  })

  it('restores the URL Kabanda across back and forward navigation', () => {
    const available = ['kabanda-a', 'kabanda-b']
    expect(resolveSelectedKabandaId(available, 'kabanda-a', 'kabanda-b')).toBe('kabanda-a')
    expect(resolveSelectedKabandaId(available, 'kabanda-b', 'kabanda-a')).toBe('kabanda-b')
    expect(resolveSelectedKabandaId(available, 'missing', 'kabanda-b')).toBe('kabanda-b')
  })
})
