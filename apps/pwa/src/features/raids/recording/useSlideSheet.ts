import { useLayoutEffect, useRef, type PointerEvent, type MouseEvent } from 'react'

const duration = 260
const offscreen = 'translate3d(0, calc(100% + 32px), 0)'
const rest = 'translate3d(0, 0, 0)'

function fitSheetViewport(element: HTMLElement) {
  const viewport = window.visualViewport
  if (!viewport || viewport.scale !== 1) return
  element.style.setProperty('--sheet-viewport-height', `${viewport.height}px`)
  element.style.setProperty('--sheet-keyboard-inset', `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`)
}

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
      frame = requestAnimationFrame(() => { if (!gesture.current) element.style.transform = rest })
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

  useLayoutEffect(() => {
    const element = ref.current
    const viewport = window.visualViewport
    if (!element || !open || !viewport) return
    let frame = 0
    const fitViewport = () => {
      // Pin the sheet above the software keyboard without reacting to pinch zoom.
      if (viewport.scale !== 1 || gesture.current) return
      fitSheetViewport(element)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const focused = document.activeElement
        if (gesture.current || !(focused instanceof HTMLTextAreaElement) || !element.contains(focused)) return
        const body = focused.closest<HTMLElement>('.raid-arrival-sheet__body')
        if (!body) return
        const fieldRect = focused.getBoundingClientRect()
        const bodyRect = body.getBoundingClientRect()
        // Scroll only the content, never the document or the sheet itself.
        if (fieldRect.bottom > bodyRect.bottom) body.scrollTop += fieldRect.bottom - bodyRect.bottom + 12
        else if (fieldRect.top < bodyRect.top) body.scrollTop -= bodyRect.top - fieldRect.top + 12
      })
    }
    fitViewport()
    viewport.addEventListener('resize', fitViewport)
    viewport.addEventListener('scroll', fitViewport)
    window.addEventListener('resize', fitViewport)
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', fitViewport)
      viewport.removeEventListener('scroll', fitViewport)
      window.removeEventListener('resize', fitViewport)
    }
  }, [open])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !open) return
    let candidate: { id: number; x: number; y: number; handle: boolean } | null = null
    const restore = () => {
      fitSheetViewport(element)
      element.style.transition = matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'none' : `transform ${duration}ms cubic-bezier(0.32, 0.72, 0, 1)`
      element.style.transform = rest
    }
    const start = (event: TouchEvent) => {
      suppressClick.current = false
      candidate = null
      if (event.touches.length !== 1 || !(event.target instanceof Element)) return
      const target = event.target
      const handle = Boolean(target.closest('[data-sheet-drag]'))
      if (target.closest('button:not([data-sheet-drag]), input, textarea, select, a, label')) return
      const body = target.closest<HTMLElement>('.raid-arrival-sheet__body')
      if (!handle && (!body || body.scrollTop > 0)) return
      const touch = event.touches[0]!
      candidate = { id: touch.identifier, x: touch.clientX, y: touch.clientY, handle }
      suppressClick.current = false
    }
    const move = (event: TouchEvent) => {
      if (!candidate || event.touches.length !== 1) return
      const touch = event.touches[0]!
      if (touch.identifier !== candidate.id) return
      const distance = touch.clientY - candidate.y
      if (!gesture.current) {
        if (Math.abs(touch.clientX - candidate.x) > Math.abs(distance) || distance < -4) { candidate = null; return }
        if (distance <= 4) return
        const body = event.target instanceof Element ? event.target.closest<HTMLElement>('.raid-arrival-sheet__body') : null
        if (!candidate.handle && body && body.scrollTop > 0) { candidate = null; return }
        gesture.current = { id: touch.identifier, start: candidate.y, last: touch.clientY, time: event.timeStamp, velocity: 0 }
        const focused = document.activeElement
        if (focused instanceof HTMLElement && element.contains(focused)) focused.blur()
      }
      event.preventDefault()
      const drag = gesture.current
      drag.velocity = (touch.clientY - drag.last) / Math.max(1, event.timeStamp - drag.time)
      drag.last = touch.clientY
      drag.time = event.timeStamp
      suppressClick.current = true
      element.style.transition = 'none'
      element.style.transform = `translate3d(0, ${Math.max(0, distance)}px, 0)`
    }
    const end = (event: TouchEvent) => {
      const drag = gesture.current
      candidate = null
      gesture.current = null
      if (!drag) return
      const distance = Math.max(0, drag.last - drag.start)
      const velocity = event.timeStamp - drag.time < 100 ? drag.velocity : 0
      if (event.type !== 'touchcancel' && (distance > Math.min(120, element.clientHeight * .3) || (distance > 28 && velocity > .5))) dismiss.current()
      else restore()
    }
    element.addEventListener('touchstart', start, { passive: true })
    element.addEventListener('touchmove', move, { passive: false })
    element.addEventListener('touchend', end)
    element.addEventListener('touchcancel', end)
    return () => {
      element.removeEventListener('touchstart', start)
      element.removeEventListener('touchmove', move)
      element.removeEventListener('touchend', end)
      element.removeEventListener('touchcancel', end)
    }
  }, [open])

  const reset = () => {
    const element = ref.current
    if (!element) return
    element.style.transition = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'none' : `transform ${duration}ms cubic-bezier(0.32, 0.72, 0, 1)`
    fitSheetViewport(element)
    element.style.transform = rest
  }
  return {
    ref,
    onPointerDown: (event: PointerEvent<T>) => {
      if (!gesture.current) suppressClick.current = false
      if (event.pointerType === 'touch' || !open || gesture.current || !event.isPrimary || event.button !== 0) return
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
      if (event.pointerType === 'touch') return
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
      if (event.pointerType === 'touch') return
      const drag = gesture.current
      if (!drag || drag.id !== event.pointerId) return
      gesture.current = null
      const distance = Math.max(0, event.clientY - drag.start)
      const velocity = event.timeStamp - drag.time < 100 ? drag.velocity : 0
      if (distance > Math.min(120, event.currentTarget.clientHeight * .3) || (distance > 28 && velocity > .5)) dismiss.current()
      else reset()
    },
    onPointerCancel: (event: PointerEvent<T>) => {
      if (event.pointerType === 'touch') return
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
