/** Visual viewport geometry, including iOS keyboard panning. Ignore page pinch zoom. */
export function pointSheetViewport(layoutHeight: number, viewport?: { height: number; offsetTop: number; scale: number } | null) {
  const usable = viewport && Math.abs(viewport.scale - 1) < .01 ? viewport : null
  const height = Math.max(1, usable?.height ?? layoutHeight)
  return {
    top: Math.min(Math.max(0, layoutHeight - height), Math.max(0, usable?.offsetTop ?? 0)),
    height,
    maxSheetHeight: Math.max(1, Math.min(460, height - 12)),
  }
}
