import { describe, expect, it, vi } from 'vitest'
import { MapMarkers } from './map-markers'
import type { YandexEventHandler, YandexMap, YandexMapsRuntime } from './yandex-maps'

type Point = { id: string; latitude: number; longitude: number; name: string; selected?: boolean; revision?: number }
const present = (point: Point) => ({ coordinate: [point.latitude, point.longitude] as const,
  properties: { label: point.name, selected: Boolean(point.selected) },
  options: { zIndex: point.selected ? 24 : 20, iconShape: { type: 'Circle', radius: 14 } },
})
function harness() {
  const add = vi.fn(), remove = vi.fn(), select = vi.fn(), createClass = vi.fn()
  class Placemark {
    geometry = { setCoordinates: vi.fn() }
    properties = { set: vi.fn() }
    options = { set: vi.fn() }
    handlers = new Map<string, YandexEventHandler>()
    events = { add: (name: string, handler: YandexEventHandler) => this.handlers.set(name, handler) }
  }
  const map = { geoObjects: { add, remove } } as unknown as YandexMap
  const runtime = { Placemark, templateLayoutFactory: { createClass } } as unknown as YandexMapsRuntime
  const markers = new MapMarkers<Point>(map, runtime, '<button/>', select)
  const drawn = () => add.mock.calls.map(([marker]) => marker as Placemark)
  return { markers, add, remove, select, createClass, drawn }
}
const points: Point[] = Array.from({ length: 500 }, (_, id) => ({ id: String(id), latitude: 56.85 + id * .0001, longitude: 53.2, name: `Point ${id}` }))

describe('persistent map markers', () => {
  it('keeps 500 SDK markers and one layout alive across fresh but unchanged server snapshots', () => {
    const h = harness()
    h.markers.update(points, present)
    h.markers.update(points.map(point => ({ ...point, revision: 2 })), present)
    expect(h.createClass).toHaveBeenCalledTimes(1)
    expect(h.add).toHaveBeenCalledTimes(500)
    expect(h.remove).not.toHaveBeenCalled()
    for (const marker of h.drawn()) {
      expect(marker.geometry.setCoordinates).not.toHaveBeenCalled()
      expect(marker.properties.set).not.toHaveBeenCalled()
      expect(marker.options.set).not.toHaveBeenCalled()
    }
  })

  it('updates just selection fields, retaining geometry and all other markers', () => {
    const h = harness()
    h.markers.update(points, present)
    h.markers.update(points.map(point => point.id === '8' ? { ...point, selected: true } : point), present)
    expect(h.add).toHaveBeenCalledTimes(500)
    expect(h.drawn()[8]!.properties.set).toHaveBeenCalledExactlyOnceWith('selected', true)
    expect(h.drawn()[8]!.options.set).toHaveBeenCalledExactlyOnceWith('zIndex', 24)
    expect(h.drawn()[8]!.geometry.setCoordinates).not.toHaveBeenCalled()
    expect(h.drawn()[9]!.properties.set).not.toHaveBeenCalled()
  })

  it('clicks use the latest data even when no marker repaint was necessary', () => {
    const h = harness()
    h.markers.update([points[0]!], present)
    const fresh = { ...points[0]!, revision: 3 }
    h.markers.update([fresh], present)
    const stopPropagation = vi.fn()
    h.drawn()[0]!.handlers.get('click')!({ get: vi.fn(), stopPropagation })
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(h.select).toHaveBeenCalledExactlyOnceWith(fresh)
    expect(h.markers.get('0')).toBe(fresh)
  })

  it('moves changed coordinates in place and removes only points absent from the new collection', () => {
    const h = harness()
    h.markers.update(points.slice(0, 2), present)
    h.markers.update([{ ...points[1]!, latitude: 57 }], present)
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(h.drawn()[0])
    expect(h.drawn()[1]!.geometry.setCoordinates).toHaveBeenCalledExactlyOnceWith([57, 53.2])
    expect(h.markers.get('0')).toBeUndefined()
    h.markers.clear()
    expect(h.remove).toHaveBeenCalledTimes(2)
    expect(h.markers.get('1')).toBeUndefined()
  })
})
