import { describe, expect, it } from 'vitest'
import { INITIAL_MAP_VIEW, MapViewportMemory } from './map-viewport'

describe('workspace map viewport', () => {
  it('retains center and zoom through map recreation without sharing across teams', () => {
    const memory = new MapViewportMemory()
    memory.remember({ center: [53.24, 56.89], zoom: 16 })
    expect(memory.read()).toEqual({ center: [53.24, 56.89], zoom: 16 })
    expect(new MapViewportMemory().read()).toEqual(INITIAL_MAP_VIEW)
  })
  it('keeps an explicit map interaction so a later automatic fix does not recenter it', () => {
    const memory = new MapViewportMemory()
    memory.userInteracted()
    expect(memory.canAutoCenter()).toBe(false)
  })
  it('rejects malformed camera state and returns an independent value', () => {
    const memory = new MapViewportMemory()
    memory.remember({ center: [Infinity, 56], zoom: 12 })
    memory.remember({ center: [53, 100], zoom: 12 })
    memory.remember({ center: [53, 56], zoom: NaN })
    const view = memory.read(); view.zoom = 1
    expect(memory.read()).toEqual(INITIAL_MAP_VIEW)
  })
})
