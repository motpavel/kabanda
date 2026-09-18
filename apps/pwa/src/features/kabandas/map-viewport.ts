export type MapView = { center: readonly [number, number]; zoom: number }
export const INITIAL_MAP_VIEW: MapView = { center: [53.2045, 56.8528], zoom: 12 }
const copy = (view: MapView): MapView => ({ center: [view.center[0], view.center[1]], zoom: view.zoom })

/** One workspace owns this object. Only camera state is retained, never a
 * browser map, watchPosition handle, user location or another team's data. */
export class MapViewportMemory {
  private view = copy(INITIAL_MAP_VIEW)
  private autoLocateStarted = false
  private interacted = false
  read(): MapView { return copy(this.view) }
  remember(view: MapView) {
    if (!Number.isFinite(view.zoom) || view.zoom < 0 || view.zoom > 24 ||
      !Number.isFinite(view.center[0]) || Math.abs(view.center[0]) > 180 ||
      !Number.isFinite(view.center[1]) || Math.abs(view.center[1]) > 90) return
    this.view = copy(view)
  }
  beginAutoLocate(): boolean {
    if (this.autoLocateStarted) return false
    this.autoLocateStarted = true
    return true
  }
  userInteracted() { this.interacted = true }
  canAutoCenter(): boolean { return !this.interacted }
}
