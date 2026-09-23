import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StyleSpecification } from 'maplibre-gl'
import { createMapLibreRuntime, renderMarkerTemplate } from './maplibre-runtime'

const style: StyleSpecification = { version: 8, sources: {}, layers: [] }
const start = [56.85, 53.2] as const

function harness() {
  const maps: NativeMap[] = [], markers: NativeMarker[] = []
  class Element {
    style: Record<string, string> = {}
    innerHTML = ''
    handlers = new Map<string, (event: Event) => void>()
    addEventListener(name: string, handler: (event: Event) => void) { this.handlers.set(name, handler) }
  }
  vi.stubGlobal('document', { createElement: () => new Element() })
  vi.stubGlobal('devicePixelRatio', 3)
  class NativeMap {
    handlers = new Map<string, Set<(event?: any) => void>>()
    sources = new Map<string, { data: unknown; setData: ReturnType<typeof vi.fn> }>()
    layers = new Map<string, any>()
    order: string[] = []
    center: { lat: number; lng: number }
    zoom: number
    loaded = false
    moving = false
    touchZoomRotate = { disableRotation: vi.fn() }
    constructor(readonly options: any) { this.center = { lat: options.center[1], lng: options.center[0] }; this.zoom = options.zoom; maps.push(this) }
    on(name: string, handler: (event?: any) => void) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name)!.add(handler); return this }
    off(name: string, handler: (event?: any) => void) { this.handlers.get(name)?.delete(handler); return this }
    emit(name: string, event?: any) { if (name === 'moveend') this.moving = false; for (const handler of [...this.handlers.get(name) ?? []]) handler(event) }
    getCenter = () => this.center
    getZoom = () => this.zoom
    resize = vi.fn()
    remove = vi.fn()
    isStyleLoaded = () => this.loaded
    isMoving = () => this.moving
    stop = vi.fn(() => { if (this.moving) { this.moving = false; this.emit('moveend') }; return this })
    update(options: any) { if (options.center) this.center = { lat: options.center[1], lng: options.center[0] }; if (options.zoom !== undefined) this.zoom = options.zoom }
    jumpTo = vi.fn((options: any) => { this.update(options); this.emit('move'); return this })
    easeTo = vi.fn((options: any) => { this.update(options); this.moving = true; return this })
    flyTo = vi.fn((options: any) => { this.update(options); this.moving = true; return this })
    getSource = (id: string) => this.sources.get(id)
    getLayer = (id: string) => this.layers.get(id)
    addSource = vi.fn((id: string, options: any) => {
      // A pending GeoJSON worker response makes isStyleLoaded false, but the
      // style is already ready to accept every remaining route layer.
      this.loaded = false
      const source = { data: options.data, setData: vi.fn((data: unknown) => { source.data = data }) }
      this.sources.set(id, source)
    })
    addLayer = vi.fn((layer: any) => { this.layers.set(layer.id, layer); this.order.push(layer.id) })
    moveLayer = vi.fn((id: string) => { this.order = this.order.filter(value => value !== id); this.order.push(id) })
    removeLayer = vi.fn((id: string) => { this.layers.delete(id); this.order = this.order.filter(value => value !== id) })
    removeSource = vi.fn((id: string) => { this.sources.delete(id) })
    setPaintProperty = vi.fn((id: string, key: string, value: unknown) => { this.layers.get(id).paint[key] = value })
    load() { this.loaded = true; this.emit('style.load') }
  }
  class NativeMarker {
    coordinate?: readonly number[]
    constructor(readonly options: any) { markers.push(this) }
    setLngLat = vi.fn((coordinate: readonly number[]) => { this.coordinate = coordinate; return this })
    addTo = vi.fn(() => this)
    remove = vi.fn()
  }
  const runtime = createMapLibreRuntime({ Map: NativeMap, Marker: NativeMarker } as unknown as typeof import('maplibre-gl'), style)
  const map = new runtime.Map({} as HTMLElement, { center: start, zoom: 13 })
  return { runtime, map, native: maps[0]!, markers }
}

afterEach(() => vi.unstubAllGlobals())

describe('offline map display adapter', () => {
  it('keeps latitude-first application coordinates and emits converted movement/click values', () => {
    const h = harness(), bounds = vi.fn(), click = vi.fn()
    expect(h.native.options.center).toEqual([53.2, 56.85])
    expect(h.native.options.zoom).toBe(12)
    expect(h.map.getZoom()).toBe(13)
    expect(h.native.options.maxBounds).toEqual([[53, 56.7], [53.4, 57]])
    expect(h.native.options.pixelRatio).toBe(2)
    expect(h.map.getCenter()).toEqual(start)
    h.map.events.add('boundschange', bounds)
    h.native.center = { lat: 56.86, lng: 53.21 }; h.native.zoom = 14
    h.native.emit('move')
    expect(bounds.mock.calls[0]![0].get('newCenter')).toEqual([56.86, 53.21])
    expect(bounds.mock.calls[0]![0].get('newZoom')).toBe(15)
    h.map.events.add('click', click)
    h.native.emit('click', { lngLat: { lng: 53.3, lat: 56.9 }, originalEvent: { stopPropagation: vi.fn() } })
    expect(click.mock.calls[0]![0].get('coords')).toEqual([56.9, 53.3])
    h.map.events.remove?.('click', click)
    h.native.emit('click', { lngLat: { lng: 53.3, lat: 56.9 } })
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('settles smooth camera promises only on completion, replacement, interruption or destroy', async () => {
    const h = harness(), finished = vi.fn()
    const flight = Promise.resolve(h.map.panTo([56.9, 53.3], { duration: 650, flying: true })).then(finished)
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    expect(h.native.flyTo.mock.calls[0]![0]).toMatchObject({ center: [53.3, 56.9], duration: 650 })
    const zoom = h.map.setZoom(16, { duration: 260 })
    expect(h.native.easeTo.mock.calls[0]![0]).toMatchObject({ zoom: 15, duration: 260 })
    await flight
    expect(finished).toHaveBeenCalledTimes(1)
    h.native.stop() // A user's drag interrupts the animation.
    await zoom
    const nextFlight = h.map.panTo(start, { duration: 650 })
    h.map.destroy()
    await nextFlight
    expect(h.native.handlers.get('moveend')?.size).toBe(0)
    expect(h.native.remove).toHaveBeenCalledTimes(1)
    await h.map.setCenter(start, 13)
  })

  it('resolves immediate and clamped no-op camera moves without waiting for an event', async () => {
    const h = harness()
    await h.map.setCenter([56.88, 53.25], 14, { duration: 0 })
    expect(h.native.jumpTo).toHaveBeenCalledWith({ center: [53.25, 56.88], zoom: 13 })
    h.native.easeTo.mockImplementation(() => h.native)
    await h.map.setZoom(14, { duration: 260 })
    expect(h.native.handlers.get('moveend')?.size).toBe(0)
  })

  it('waits for the final animation frame before releasing follow-camera updates', async () => {
    const h = harness(), finished = vi.fn()
    const flight = Promise.resolve(h.map.panTo([56.9, 53.3], { duration: 650, flying: true })).then(finished)
    h.native.emit('move')
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    h.native.emit('moveend')
    await flight
    expect(finished).toHaveBeenCalledTimes(1)
    expect(h.native.handlers.get('moveend')?.size).toBe(0)
  })

  it('retains markers and their geographic origin while updating coordinates, labels and selected state', () => {
    const h = harness()
    const template = h.runtime.templateLayoutFactory.createClass('<button class="{{ properties.markerClass }}" aria-label="{{ properties.label }}">{{ properties.number }}</button>')
    const point = new h.runtime.Placemark(start, { markerClass: 'point', label: 'Двор', number: 1 }, { iconLayout: template, zIndex: 20 })
    const click = vi.fn(event => event.stopPropagation())
    point.events.add('click', click)
    h.map.geoObjects.add(point)
    h.map.geoObjects.add(point)
    point.properties.set('label', '" onfocus="alert(1)<script>')
    point.properties.set('markerClass', 'point selected')
    point.options.set('zIndex', 30)
    point.geometry?.setCoordinates([56.9, 53.3])
    expect(h.markers).toHaveLength(1)
    const marker = h.markers[0]!, element = marker.options.element
    expect(marker.coordinate).toEqual([53.3, 56.9])
    expect(marker.options.anchor).toBe('top-left')
    expect(element.style).toMatchObject({ width: '0px', height: '0px', zIndex: '30' })
    expect(element.innerHTML).toContain('class="point selected"')
    expect(element.innerHTML).toContain('&quot; onfocus=&quot;alert(1)&lt;script&gt;')
    const stopPropagation = vi.fn()
    element.handlers.get('click')({ stopPropagation })
    expect(click).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    h.map.geoObjects.remove(point)
    expect(marker.remove).toHaveBeenCalledTimes(1)
  })

  it('queues lines until the style exists, converts segments and keeps casing below the track', async () => {
    const h = harness()
    const line = new h.runtime.Polyline([start, [56.9, 53.3]], {}, { strokeColor: '#123456', strokeWidth: 5, strokeStyle: 'shortdash', zIndex: 3 })
    const casing = new h.runtime.Polyline([start, [56.9, 53.3]], {}, { strokeColor: '#ffffff', strokeWidth: 9, zIndex: 2 })
    h.map.geoObjects.add(line); h.map.geoObjects.add(casing)
    expect(h.native.sources.size).toBe(0)
    h.native.load()
    await Promise.resolve()
    expect(h.native.sources.size).toBe(2)
    const [lineId, casingId] = [...h.native.layers.keys()]
    expect(h.native.order).toEqual([casingId, lineId])
    expect(h.native.sources.get(lineId!)!.data).toMatchObject({ features: [{ geometry: { type: 'LineString', coordinates: [[53.2, 56.85], [53.3, 56.9]] } }] })
    expect(h.native.layers.get(lineId!)!.paint).toMatchObject({ 'line-width': 5, 'line-color': '#123456', 'line-dasharray': [2, 2] })
    line.geometry.setCoordinates([start, [56.88, 53.25]])
    expect(h.native.sources.get(lineId!)!.setData).toHaveBeenCalledTimes(1)
    expect(h.native.addSource).toHaveBeenCalledTimes(2)
    h.map.geoObjects.remove(casing)
    expect(h.native.removeLayer).toHaveBeenCalledWith(casingId)
    expect(h.native.removeSource).toHaveBeenCalledWith(casingId)
    h.map.destroy()
    expect(h.native.sources.size).toBe(0)
  })

  it('keeps discontinuous line segments separate and skips incomplete one-point segments', () => {
    const h = harness()
    // The adapter accepts multi-lines at runtime without joining missing GPS.
    const Polyline = h.runtime.Polyline as unknown as new (points: unknown) => { geometry: { setCoordinates: (points: unknown) => void } }
    const line = new Polyline([[start, [56.9, 53.3]], [[56.8, 53.1], [56.81, 53.11]], [[56.82, 53.12]]])
    h.map.geoObjects.add(line); h.native.load()
    const source = [...h.native.sources.values()][0]!
    expect(source.data).toMatchObject({ features: [{ geometry: { type: 'MultiLineString', coordinates: [
      [[53.2, 56.85], [53.3, 56.9]], [[53.1, 56.8], [53.11, 56.81]],
    ] } }] })
    line.geometry.setCoordinates([start])
    expect(source.data).toEqual({ type: 'FeatureCollection', features: [] })
  })

  it('updates line appearance in place and never revives lines removed before style load', async () => {
    const h = harness()
    const deleted = new h.runtime.Polyline([start, [56.9, 53.3]])
    h.map.geoObjects.add(deleted); h.map.geoObjects.remove(deleted)
    h.native.load()
    expect(h.native.sources.size).toBe(0)
    const line = new h.runtime.Polyline([start, [56.9, 53.3]]) as InstanceType<typeof h.runtime.Polyline> & { options: { set: (name: string, value: unknown) => void } }
    h.map.geoObjects.add(line)
    line.options.set('strokeColor', '#abcdef')
    line.options.set('strokeWidth', 7)
    line.options.set('strokeOpacity', .4)
    line.options.set('strokeStyle', 'shortdash')
    const layer = [...h.native.layers.values()][0]!
    expect(layer.paint).toMatchObject({ 'line-color': '#abcdef', 'line-width': 7, 'line-opacity': .4, 'line-dasharray': [2, 2] })
    expect(h.native.addLayer).toHaveBeenCalledTimes(1)
    h.map.destroy()
    await Promise.resolve()
    expect(h.native.moveLayer).not.toHaveBeenCalled()
  })

  it('escapes all template substitutions as text, including quotes in HTML attributes', () => {
    expect(renderMarkerTemplate('<b title="{{ properties.name }}">{{ properties.name }}</b>', { name: '<&"\'' }))
      .toBe('<b title="&lt;&amp;&quot;&#39;">&lt;&amp;&quot;&#39;</b>')
  })
})
