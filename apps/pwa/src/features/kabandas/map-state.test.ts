import { describe, expect, it } from 'vitest'
import { choosePointPresentation } from './map-state'

describe('point provider fallback', () => {
  it('uses the complete list when WebGL or the provider is unavailable', () => {
    expect(choosePointPresentation('map', 'ready', false)).toBe('list')
    expect(choosePointPresentation('map', 'failed', true)).toBe('list')
    expect(choosePointPresentation('map', 'failed', false)).toBe('list')
  })

  it('respects an explicit list choice and shows a map only when safe', () => {
    expect(choosePointPresentation('list', 'ready', true)).toBe('list')
    expect(choosePointPresentation('map', 'ready', true)).toBe('map')
  })
})
