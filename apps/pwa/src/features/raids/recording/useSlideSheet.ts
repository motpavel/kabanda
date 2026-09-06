import { useLayoutEffect, useRef, type PointerEvent, type MouseEvent } from 'react'

const duration = 260
const offscreen = 'translate3d(0, calc(100% + 32px), 0)'
const rest = 'translate3d(0, 0, 0)'

/** One mounted surface: drafts survive dismissal; modal focus survives exit. */
export function useSlideSheet<T extends HTMLElement>(open: boolean, onDismiss: () => void) {
  const ref = useRef<T>(null)
  const dismiss = useRef(onDismiss)
  const gesture = useRef<{ id: number; start: number; last: number; time: number; velocity: number } | null>(null)
  const suppressClick = useRef(false)
  dismiss.current = onDismiss

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const modal = element instanceof HTMLDialogElement ? element : null
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame = 0
    let timer = 0
    gesture.current = null
    const finishClose = () => {
      if (modal?.open) modal.close()
      element.hidden = true
      element.dataset.sheetState = 'closed'
    }
    element.style.transition = reduced ? 'none' : `transform ${duration}ms cubic-bezier(0.32, 0.72, 0, 1)`
    if (open) {
      const wasClosed = !element.dataset.sheetState || element.dataset.sheetState === 'closed'
      element.hidden = false
      element.inert = false
      if (modal && !modal.open) modal.showModal()
      if (wasClosed && !reduced) {
        element.style.transition = 'none'
        element.style.transform = offscreen
        element.getBoundingClientRect()
        element.style.transition = `transform ${duration}ms cubic-bezier(0.32, 0.72, 0, 1)`
      }
      element.dataset.sheetState = 'open'
      frame = requestAnimationFrame(() => { element.style.transform = rest })
    } else {
      element.inert = true
      element.style.transform = offscreen
      if (!element.dataset.sheetState || element.dataset.sheetState === 'closed' || reduced) finishClose()
      else {
        element.dataset.sheetState = 'closing'
        timer = window.setTimeout(finishClose, duration)
      }
    }
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer) }
  }, [open])

  const reset = () => {
    const element = ref.current
    if (!element) return
    element.style.transition = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'none' : `transform ${duration}ms cubic-bezier(0.32, 0.72, 0, 1)`
    element.style.transform = rest
  }
  return {
    ref,
    onPointerDown: (event: PointerEvent<T>) => {
      if (!open || gesture.current || !event.isPrimary || event.button !== 0) return
      if (!(event.target instanceof Element)) return
      const handle = event.target.closest<HTMLElement>('[data-sheet-drag]')
      if (!handle) return
      if (event.target.closest('button:not([data-sheet-drag]), input, textarea, select, a')) return
      gesture.current = { id: event.pointerId, start: event.clientY, last: event.clientY, time: event.timeStamp, velocity: 0 }
      suppressClick.current = false
      // Capture on the handle, not the sheet: a simple tap must still click
      // its collapse button rather than being retargeted to the whole sheet.
      handle.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event: PointerEvent<T>) => {
      const drag = gesture.current
      if (!drag || drag.id !== event.pointerId) return
      const distance = Math.max(0, event.clientY - drag.start)
      drag.velocity = (event.clientY - drag.last) / Math.max(1, event.timeStamp - drag.time)
      drag.last = event.clientY
      drag.time = event.timeStamp
      if (distance > 6) suppressClick.current = true
      event.currentTarget.style.transition = 'none'
      event.currentTarget.style.transform = `translate3d(0, ${distance}px, 0)`
    },
    onPointerUp: (event: PointerEvent<T>) => {
      const drag = gesture.current
      if (!drag || drag.id !== event.pointerId) return
      gesture.current = null
      const distance = Math.max(0, event.clientY - drag.start)
      const velocity = event.timeStamp - drag.time < 100 ? drag.velocity : 0
      if (distance > Math.min(120, event.currentTarget.clientHeight * .3) || (distance > 28 && velocity > .5)) dismiss.current()
      else reset()
    },
    onPointerCancel: (event: PointerEvent<T>) => {
      if (gesture.current?.id !== event.pointerId) return
      gesture.current = null
      reset()
    },
    onClickCapture: (event: MouseEvent<T>) => {
      if (!suppressClick.current) return
      suppressClick.current = false
      event.preventDefault()
      event.stopPropagation()
    },
  }
}
