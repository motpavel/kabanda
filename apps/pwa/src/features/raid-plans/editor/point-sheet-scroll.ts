/** Only the form body (or a long note inside it) may consume a vertical gesture. */
export function pointSheetCanScroll(target: Element, content: HTMLElement, deltaY: number) {
  if (!content.contains(target) || deltaY === 0) return false
  const note = target.closest<HTMLTextAreaElement>('textarea')
  const candidates = note && content.contains(note) ? [note, content] : [content]
  return candidates.some(element => {
    const max = element.scrollHeight - element.clientHeight
    return max > 1 && (deltaY > 0 ? element.scrollTop < max - 1 : element.scrollTop > 1)
  })
}

/** Safari ignores overflow:hidden when its keyboard is open. Stop gestures before
 * they reach the root scroller, including gestures on a non-overflowing form. */
export function containPointSheetScroll(sheet: HTMLElement, content: HTMLElement, isEditing: () => boolean) {
  const doc = sheet.ownerDocument
  let gesture: { target: Element; x: number; y: number } | null = null
  const mapGesture = (target: Element) => !isEditing() && !!target.closest('.rt-map--point-editing') && !sheet.contains(target)
  const onStart = (event: TouchEvent) => {
    const touch = event.touches[0]
    gesture = touch ? { target: event.target as Element, x: touch.clientX, y: touch.clientY } : null
  }
  const onMove = (event: TouchEvent) => {
    const touch = event.touches[0]
    const target = gesture?.target ?? event.target as Element
    if (!target || typeof target.closest !== 'function') {
      if (event.cancelable) event.preventDefault()
      return
    }
    if (mapGesture(target)) return
    // Keep page zoom available outside text entry. Map pinch is handled above.
    if (event.touches.length > 1 && !isEditing()) return
    const deltaY = gesture && touch ? gesture.y - touch.clientY : 0
    const deltaX = gesture && touch ? gesture.x - touch.clientX : 0
    if (gesture && touch) { gesture.y = touch.clientY; gesture.x = touch.clientX }
    const input = target.closest<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
    // Preserve horizontal caret/selection movement, without letting a selected
    // but non-scrolling field re-enable vertical page panning.
    if (input === doc.activeElement && input && event.touches.length === 1 &&
      Math.abs(deltaX) > Math.abs(deltaY)) return
    if (event.touches.length === 1 && pointSheetCanScroll(target, content, deltaY)) return
    if (event.cancelable) event.preventDefault()
  }
  const onEnd = () => { gesture = null }
  const onWheel = (event: WheelEvent) => {
    const target = event.target as Element
    if (!target || typeof target.closest !== 'function') {
      if (event.cancelable) event.preventDefault()
      return
    }
    if (mapGesture(target) || pointSheetCanScroll(target, content, event.deltaY)) return
    if (event.cancelable) event.preventDefault()
  }
  doc.addEventListener('touchstart', onStart, { capture: true, passive: true })
  doc.addEventListener('touchmove', onMove, { capture: true, passive: false })
  doc.addEventListener('touchend', onEnd, true)
  doc.addEventListener('touchcancel', onEnd, true)
  doc.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => {
    doc.removeEventListener('touchstart', onStart, true)
    doc.removeEventListener('touchmove', onMove, true)
    doc.removeEventListener('touchend', onEnd, true)
    doc.removeEventListener('touchcancel', onEnd, true)
    doc.removeEventListener('wheel', onWheel, true)
  }
}
