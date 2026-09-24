/** Visual viewport geometry, including iOS keyboard panning. Ignore page pinch zoom. */
export function sheetViewport(layoutHeight: number, viewport?: { height: number; offsetTop: number; scale: number } | null) {
  const usable = viewport && Math.abs(viewport.scale - 1) < .01 ? viewport : null
  const height = Math.max(1, usable?.height ?? layoutHeight)
  return {
    // While the keyboard is visible, honor the actual visual viewport even if
    // Safari pans it beyond the nominal layout edge. Ignore stale offsets only
    // once the viewport has recovered its full height after dismissal.
    top: height >= layoutHeight - 1 ? 0 : Math.max(0, usable?.offsetTop ?? 0),
    height,
    maxSheetHeight: Math.max(1, Math.min(460, height - 12)),
  }
}
