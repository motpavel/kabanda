import type { GeoJSONSource, Map as LibreMap, Marker as LibreMarker, StyleSpecification } from 'maplibre-gl'
import type { DisplayMapRuntime, YandexCoordinates, YandexEvent, YandexEventHandler, YandexMap } from '../kabandas/yandex-maps'

type MapLibre = typeof import('maplibre-gl')
type Lines = readonly YandexCoordinates[] | readonly (readonly YandexCoordinates[])[]
const longitudeFirst = ([latitude, longitude]: YandexCoordinates): [number, number] => [longitude, latitude]
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

/** Templates are application code; every interpolated property is plain text. */
export function renderMarkerTemplate(template: string, properties: Record<string, unknown>) {
  return template.replace(/{{\s*properties\.([\w]+)\s*}}/g, (_, property: string) => escapeHtml(properties[property]))
}

class Events {
  private handlers = new Map<string, Set<YandexEventHandler>>()
  add = (name: string, handler: YandexEventHandler) => {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set())
    this.handlers.get(name)!.add(handler)
  }
  remove = (name: string, handler: YandexEventHandler) => { this.handlers.get(name)?.delete(handler) }
  emit(name: string, values: Record<string, unknown>, original?: Event) {
    const event: YandexEvent = { get: <Value,>(key: string) => values[key] as Value, stopPropagation: () => original?.stopPropagation() }
    for (const handler of this.handlers.get(name) ?? []) handler(event)
  }
  clear() { this.handlers.clear() }
}

function lineData(coordinates: Lines | YandexCoordinates): Exclude<Parameters<GeoJSONSource['setData']>[0], string> {
  if (!coordinates.length || typeof coordinates[0] === 'number') return { type: 'FeatureCollection', features: [] }
  const lines: readonly (readonly YandexCoordinates[])[] = typeof coordinates[0]![0] === 'number'
    ? [coordinates as readonly YandexCoordinates[]] : coordinates as readonly (readonly YandexCoordinates[])[]
  const paths = lines.filter(line => line.length >= 2).map(line => line.map(longitudeFirst))
  return { type: 'FeatureCollection', features: paths.length ? [{ type: 'Feature', properties: {}, geometry: paths.length === 1
    ? { type: 'LineString', coordinates: paths[0]! } : { type: 'MultiLineString', coordinates: paths } }] : [] }
}

/** A small display boundary: routing and geocoding stay outside this adapter. */
export function createMapLibreRuntime(maplibre: MapLibre, style: StyleSpecification): DisplayMapRuntime {
  let lineSequence = 0
  type DisplayObject = Placemark | Polyline

  class DisplayMap implements YandexMap {
    readonly native: LibreMap
    readonly events = new Events()
    styleReady = false
    private objects = new Set<DisplayObject>()
    private finishMovement: (() => void) | null = null
    private destroyed = false
    private orderQueued = false
    readonly container = { fitToViewport: () => { if (!this.destroyed) this.native.resize() } }
    readonly geoObjects = {
      add: (object: object) => {
        if (this.destroyed || this.objects.has(object as DisplayObject)) return
        if (!(object instanceof Placemark) && !(object instanceof Polyline)) return
        if (object.owner) object.owner.geoObjects.remove(object)
        this.objects.add(object)
        object.attach(this)
        this.orderLines()
      },
      remove: (object: object) => {
        if (!this.objects.delete(object as DisplayObject)) return
        ;(object as DisplayObject).detach()
      },
    }

    constructor(element: HTMLElement, state: { center: YandexCoordinates; zoom: number }) {
      this.native = new maplibre.Map({
        // Existing bounds calculations use 256px zoom semantics; MapLibre uses 512px.
        container: element, style, center: longitudeFirst(state.center), zoom: state.zoom - 1,
        minZoom: 2, maxZoom: 18, maxBounds: [[53, 56.7], [53.4, 57]],
        renderWorldCopies: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
        attributionControl: { compact: true },
        pixelRatio: Math.min(globalThis.devicePixelRatio || 1, 2),
      })
      this.styleReady = Boolean(this.native.isStyleLoaded())
      this.native.touchZoomRotate.disableRotation()
      this.native.on('move', () => this.events.emit('boundschange', { newCenter: this.getCenter(), newZoom: this.getZoom() }))
      this.native.on('click', event => this.events.emit('click', { coords: [event.lngLat.lat, event.lngLat.lng] }, event.originalEvent))
      this.native.on('style.load', () => {
        this.styleReady = true
        for (const object of this.objects) if (object instanceof Polyline) object.mount()
        this.orderLines()
      })
    }

    getCenter = (): YandexCoordinates => { const center = this.native.getCenter(); return [center.lat, center.lng] }
    getZoom = () => this.native.getZoom() + 1
    panTo = (center: YandexCoordinates, options?: { duration?: number; flying?: boolean; timingFunction?: string }) =>
      this.move({ center: longitudeFirst(center) }, options?.duration ?? 0, Boolean(options?.flying))
    setCenter = (center: YandexCoordinates, zoom?: number, options?: { duration?: number }) =>
      this.move({ center: longitudeFirst(center), ...(zoom === undefined ? {} : { zoom: zoom - 1 }) }, options?.duration ?? 0)
    setZoom = (zoom: number, options?: { duration?: number }) => this.move({ zoom: zoom - 1 }, options?.duration ?? 0)

    private move(camera: { center?: [number, number]; zoom?: number }, duration: number, fly = false): Promise<void> {
      if (this.destroyed) return Promise.resolve()
      // A replacement flight must release its predecessor even when the SDK
      // clamps the new camera or emits no moveend for a no-op.
      this.finishMovement?.()
      this.native.stop()
      return new Promise(resolve => {
        const finish = () => {
          this.native.off('moveend', finish)
          if (this.finishMovement === finish) this.finishMovement = null
          resolve()
        }
        this.finishMovement = finish
        this.native.on('moveend', finish)
        if (duration <= 0) { this.native.jumpTo(camera); finish(); return }
        const options = { ...camera, duration, easing: (t: number) => t * t * (3 - 2 * t) }
        if (fly) this.native.flyTo(options)
        else this.native.easeTo(options)
        if (!this.native.isMoving()) finish()
      })
    }

    orderLines() {
      if (this.orderQueued || this.destroyed) return
      this.orderQueued = true
      queueMicrotask(() => {
        this.orderQueued = false
        if (this.destroyed || !this.styleReady) return
        const lines = [...this.objects].filter((object): object is Polyline => object instanceof Polyline)
          .sort((a, b) => a.zIndex - b.zIndex)
        for (const line of lines) if (this.native.getLayer(line.id)) this.native.moveLayer(line.id)
      })
    }

    destroy = () => {
      if (this.destroyed) return
      this.destroyed = true
      this.finishMovement?.()
      for (const object of this.objects) object.detach()
      this.objects.clear()
      this.events.clear()
      this.native.remove()
    }
  }

  class Placemark {
    owner: DisplayMap | null = null
    readonly events = new Events()
    readonly element = document.createElement('div')
    private marker: LibreMarker | null = null
    private values: Record<string, unknown>
    private configuration: Record<string, unknown>
    private coordinate: YandexCoordinates
    readonly geometry = { setCoordinates: (coordinate: YandexCoordinates) => { this.coordinate = coordinate; this.marker?.setLngLat(longitudeFirst(coordinate)) } }
    readonly properties = {
      get: <Value,>(name: string) => this.values[name] as Value,
      set: (name: string, value: unknown) => { if (this.values[name] === value) return; this.values[name] = value; this.render() },
    }
    readonly options = { set: (name: string, value: unknown) => { this.configuration[name] = value; this.render() } }

    constructor(coordinate: YandexCoordinates, properties: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
      this.coordinate = coordinate
      this.values = { ...properties }
      this.configuration = { ...options }
      // Existing marker CSS translates its child relative to the coordinate.
      // Keep MapLibre's anchoring wrapper dimensionless to avoid a second offset.
      this.element.style.width = '0px'
      this.element.style.height = '0px'
      this.element.style.overflow = 'visible'
      this.element.addEventListener('click', event => this.events.emit('click', {}, event))
      this.render()
    }
    private render() {
      const template = typeof this.configuration.iconLayout === 'string' ? this.configuration.iconLayout : ''
      const html = renderMarkerTemplate(template, this.values)
      if (this.element.innerHTML !== html) this.element.innerHTML = html
      this.element.style.zIndex = String(this.configuration.zIndex ?? 0)
    }
    attach(map: DisplayMap) {
      this.owner = map
      this.marker = new maplibre.Marker({ element: this.element, anchor: 'top-left', subpixelPositioning: true })
        .setLngLat(longitudeFirst(this.coordinate)).addTo(map.native)
    }
    detach() { this.marker?.remove(); this.marker = null; this.owner = null }
  }

  class Polyline {
    readonly id = `kabanda-line-${++lineSequence}`
    owner: DisplayMap | null = null
    private coordinates: Lines | YandexCoordinates
    private configuration: Record<string, unknown>
    readonly geometry = {
      getCoordinates: () => this.coordinates,
      setCoordinates: (coordinates: Lines | YandexCoordinates) => {
        this.coordinates = coordinates
        const source = this.owner?.native.getSource(this.id) as GeoJSONSource | undefined
        source?.setData(lineData(coordinates))
      },
    }
    readonly options = { set: (name: string, value: unknown) => {
      this.configuration[name] = value
      this.paint()
      if (name === 'zIndex') this.owner?.orderLines()
    } }

    constructor(coordinates: Lines, _properties: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
      this.coordinates = coordinates
      this.configuration = { ...options }
    }
    get zIndex() { return Number(this.configuration.zIndex ?? 0) }
    private paints() {
      return {
        'line-color': String(this.configuration.strokeColor ?? '#17191b'),
        'line-width': Number(this.configuration.strokeWidth ?? 3),
        'line-opacity': Number(this.configuration.strokeOpacity ?? 1),
        'line-dasharray': this.configuration.strokeStyle === 'shortdash' ? [2, 2] : [1, 0],
      }
    }
    private paint() {
      const map = this.owner?.native
      if (!map?.getLayer(this.id)) return
      for (const [name, value] of Object.entries(this.paints())) map.setPaintProperty(this.id, name as Parameters<LibreMap['setPaintProperty']>[1], value)
    }
    attach(map: DisplayMap) { this.owner = map; this.mount() }
    mount() {
      const map = this.owner?.native
      if (!map || !this.owner?.styleReady || map.getLayer(this.id)) return
      map.addSource(this.id, { type: 'geojson', data: lineData(this.coordinates) })
      map.addLayer({ id: this.id, source: this.id, type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: this.paints() })
    }
    detach() {
      const map = this.owner?.native
      if (map?.getLayer(this.id)) map.removeLayer(this.id)
      if (map?.getSource(this.id)) map.removeSource(this.id)
      this.owner = null
    }
  }

  return { Map: DisplayMap, Placemark, Polyline, templateLayoutFactory: { createClass: (template: string) => template } }
}
