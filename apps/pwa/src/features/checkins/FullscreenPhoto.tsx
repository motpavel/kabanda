import { useEffect, useRef, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import './point-materials.css'

const materialDateTime = (value: string | number) => new Date(value).toLocaleString('ru-RU', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

export function FullscreenPhoto({ createdAt, onClose, children }: { createdAt: string | number; onClose: () => void; children: ReactNode }) {
  const close = useRef(onClose)
  close.current = onClose
  const viewerCloseRef = useRef<HTMLButtonElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const viewerGesture = useRef<{ pointerId: number; startX: number; startY: number; lastY: number; lastAt: number; velocity: number; intent: 'pending' | 'vertical' | 'cancelled' } | null>(null)
  const viewerCloseTimer = useRef<number | null>(null)
  const suppressViewerClick = useRef(false)
  useEffect(() => {
    viewerCloseRef.current?.focus({ preventScroll: true })
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current() }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      if (viewerCloseTimer.current !== null) window.clearTimeout(viewerCloseTimer.current)
      viewerCloseTimer.current = null
      viewerGesture.current = null
    }
  }, [])

  const resetViewerPosition = () => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.style.transition = 'transform 260ms cubic-bezier(.22, 1, .36, 1), opacity 180ms ease'
    viewer.style.transform = 'translate3d(0, 0, 0)'
    viewer.style.opacity = '1'
  }
  const dismissPhotoViewer = (fromGesture = false) => {
    const viewer = viewerRef.current
    if (!fromGesture || !viewer || matchMedia('(prefers-reduced-motion: reduce)').matches) { close.current(); return }
    viewer.style.transition = 'transform 190ms cubic-bezier(.32, .72, 0, 1), opacity 150ms ease'
    viewer.style.transform = `translate3d(0, ${window.innerHeight + 40}px, 0)`
    viewer.style.opacity = '0'
    viewerCloseTimer.current = window.setTimeout(() => close.current(), 190)
  }
  const onViewerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.target as HTMLElement).closest('button')) return
    viewerGesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, lastY: event.clientY, lastAt: event.timeStamp, velocity: 0, intent: 'pending' }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onViewerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = viewerGesture.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY
    if (gesture.intent === 'pending' && Math.max(Math.abs(dx), Math.abs(dy)) > 8) gesture.intent = Math.abs(dy) > Math.abs(dx) * 1.15 ? 'vertical' : 'cancelled'
    if (gesture.intent !== 'vertical') return
    event.preventDefault()
    const offset = dy < 0 ? dy * .14 : dy
    const viewer = viewerRef.current
    if (viewer) {
      viewer.style.transition = 'none'
      viewer.style.transform = `translate3d(0, ${offset}px, 0)`
      viewer.style.opacity = String(1 - Math.min(.5, Math.max(0, dy) / Math.max(320, window.innerHeight) * .72))
    }
    gesture.velocity = (event.clientY - gesture.lastY) / Math.max(1, event.timeStamp - gesture.lastAt)
    gesture.lastY = event.clientY; gesture.lastAt = event.timeStamp
  }
  const finishViewerGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = viewerGesture.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    viewerGesture.current = null
    const distance = event.clientY - gesture.startY
    suppressViewerClick.current = gesture.intent === 'vertical' && Math.abs(distance) > 8
    if (gesture.intent === 'vertical' && (distance > Math.min(140, window.innerHeight * .2) || (distance > 32 && gesture.velocity > .55))) dismissPhotoViewer(true)
    else resetViewerPosition()
  }

  return createPortal(<div ref={viewerRef} className="point-materials__viewer" role="dialog" aria-modal="true" aria-label="Просмотр фото" onPointerDown={onViewerPointerDown} onPointerMove={onViewerPointerMove} onPointerUp={finishViewerGesture} onPointerCancel={finishViewerGesture} onClick={() => {
    if (suppressViewerClick.current) { suppressViewerClick.current = false; return }
    dismissPhotoViewer()
  }}>
    <header><time>{materialDateTime(createdAt)}</time><button ref={viewerCloseRef} type="button" aria-label="Закрыть фото" onClick={event => { event.stopPropagation(); dismissPhotoViewer() }}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg></button></header>
    <div onClick={event => event.stopPropagation()}>
      {children}
    </div>
  </div>, document.body)
}
