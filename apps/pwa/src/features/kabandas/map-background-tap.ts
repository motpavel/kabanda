type MapPointer = {
  pointerId: number
  clientX: number
  clientY: number
  timeStamp: number
}
type MarkerBounds = { left: number; top: number; width: number; height: number }

/** Only a short, single-finger tap should dismiss an open point sheet. */
export class MapBackgroundTap {
  private start: (MapPointer & { moved: boolean }) | null = null

  down(event: MapPointer & { button: number; isPrimary: boolean }) {
    this.start = event.isPrimary && event.button === 0
      ? { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, timeStamp: event.timeStamp, moved: false }
      : null
  }

  move(event: MapPointer) {
    const start = this.start
    if (start?.pointerId === event.pointerId && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > 8) start.moved = true
  }

  up(event: MapPointer): boolean {
    const start = this.start
    this.start = null
    if (!start || start.pointerId !== event.pointerId || start.moved) return false
    const duration = event.timeStamp - start.timeStamp
    return duration >= 0 && duration <= 500 && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) <= 8
  }

  cancel() { this.start = null }
}

/** Yandex's event pane can be the tap target even over an HTML marker. */
export function isMapMarkerHit(x: number, y: number, markers: Iterable<MarkerBounds>): boolean {
  for (const box of markers) {
    if (box.width <= 0 || box.height <= 0) continue
    const radius = Math.max(22, box.width / 2, box.height / 2)
    if (Math.hypot(x - (box.left + box.width / 2), y - (box.top + box.height / 2)) <= radius) return true
  }
  return false
}
