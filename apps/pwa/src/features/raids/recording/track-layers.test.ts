import { describe, expect, it, vi } from 'vitest'
import type { YandexMap, YandexMapsRuntime } from '../../kabandas/yandex-maps'
import type { RouteTrackPoint } from '../types'
import { updateTrackLayers, type TrackLayers } from './track-layers'

const point = (index: number): RouteTrackPoint => ({ latitude: 56.85 + index * .00001, longitude: 53.2, capturedAt: new Date(1_700_000_000_000 + index * 1_000).toISOString() })
function harness() {
  const added = vi.fn(), removed = vi.fn(), updated = vi.fn()
  const map = { geoObjects: { add: added, remove: removed } } as unknown as YandexMap
  class Polyline { geometry = { setCoordinates: updated } }
  const runtime = { Polyline } as unknown as YandexMapsRuntime
  const layers: TrackLayers = new Map()
  return { map, runtime, layers, added, removed, updated }
}

describe('incremental map geometry', () => {
  it('keeps existing map objects when a track grows and leaves unchanged segments alone', () => {
    const h = harness()
    const first = [point(0), point(1)], tail = [point(10), point(11)]
    updateTrackLayers(h.map, h.runtime, h.layers, [first, tail])
    const initial = [...h.layers.values()]
    expect(h.added).toHaveBeenCalledTimes(6)
    updateTrackLayers(h.map, h.runtime, h.layers, [first.map(p => ({ ...p })), [...tail, point(12)]])
    expect([...h.layers.values()]).toEqual(initial)
    expect(h.updated).toHaveBeenCalledTimes(2)
    expect(h.added).toHaveBeenCalledTimes(6)
    expect(h.removed).not.toHaveBeenCalled()
    updateTrackLayers(h.map, h.runtime, h.layers, [first.map(p => ({ ...p })), [...tail, point(12)]])
    expect(h.updated).toHaveBeenCalledTimes(2)
  })

  it('connects isolated fixes after unlocking without changing stored segments', () => {
    const h = harness()
    const a = point(0), b = point(300), c = point(600)
    const segments = [[a], [], [b], [c]]
    const saved = JSON.stringify(segments)
    updateTrackLayers(h.map, h.runtime, h.layers, segments)
    expect(h.layers.get(-3)?.points).toEqual([a, b])
    expect(h.layers.get(-4)?.points).toEqual([b, c])
    expect(h.added).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(segments)).toBe(saved)
  })

  it('removes a disappeared segment without leaving its previous path on the map', () => {
    const h = harness()
    updateTrackLayers(h.map, h.runtime, h.layers, [[point(0), point(1)], [point(4), point(5)]])
    updateTrackLayers(h.map, h.runtime, h.layers, [[point(0)]])
    expect(h.layers.size).toBe(0)
    expect(h.removed).toHaveBeenCalledTimes(6)
  })
})
