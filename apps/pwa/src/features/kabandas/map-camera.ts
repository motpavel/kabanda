import type { YandexCoordinates, YandexMap } from './yandex-maps'

export const MAP_RECENTER_MS = 650
const same = (a: YandexCoordinates | null, b: YandexCoordinates) => a?.[0] === b[0] && a[1] === b[1]

/** Let the SDK animate the camera once. GPS frames must not cancel that flight
 * (or a zoom-button animation) with their immediate tracking updates. */
export class MapCamera {
  private generation = 0
  private following = false
  private moving = false
  private latest: YandexCoordinates | null = null
  private painted: YandexCoordinates | null = null
  constructor(private readonly map: YandexMap, private readonly reducedMotion = () => false) {}

  center(coordinate: YandexCoordinates, follow = false) {
    this.latest = coordinate
    this.following = follow
    this.animate(() => this.map.panTo(coordinate, {
      duration: this.reducedMotion() ? 0 : MAP_RECENTER_MS,
      flying: true,
      timingFunction: 'ease-in-out',
    }))
  }

  track(coordinate: YandexCoordinates) {
    this.latest = coordinate
    if (!this.following || this.moving || same(this.painted, coordinate)) return
    this.painted = coordinate
    this.map.setCenter(coordinate, this.map.getZoom(), { duration: 0 })
  }

  zoom(zoom: number) {
    this.animate(() => this.map.setZoom(zoom, { duration: this.reducedMotion() ? 0 : 260 }))
  }

  stop() {
    this.generation++
    this.following = false
    this.moving = false
    this.painted = null
  }

  private animate(move: () => PromiseLike<void> | void) {
    const generation = ++this.generation
    this.moving = true
    this.painted = null
    const finish = () => { if (generation === this.generation) this.moving = false }
    void Promise.resolve(move()).then(() => {
      if (generation !== this.generation) return
      // The boar may have moved during the initial flight. Ease to its latest
      // displayed coordinate before handing control back to frame tracking.
      const target = this.latest
      if (!this.following || !target || same(this.map.getCenter(), target)) { finish(); return }
      return Promise.resolve(this.map.panTo(target, {
        duration: this.reducedMotion() ? 0 : 180,
        flying: false, safe: false, timingFunction: 'ease-out',
      })).then(finish, finish)
    }, finish)
  }
}
