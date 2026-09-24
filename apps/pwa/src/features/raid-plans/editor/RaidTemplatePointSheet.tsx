import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { DraftRaidTemplatePoint } from '../types'
import { usePointSheetViewport } from './usePointSheetViewport'

const POINT_SHEET_DISMISS_DISTANCE = 72
const POINT_SHEET_EXPAND_DISTANCE = 48
const POINT_SHEET_EXIT_DURATION = 160

export function shouldDismissPointSheet(startY: number, currentY: number) {
  return currentY - startY >= POINT_SHEET_DISMISS_DISTANCE
}

export function shouldExpandPointSheet(startY: number, currentY: number) {
  return startY - currentY >= POINT_SHEET_EXPAND_DISTANCE
}

export function isPointSheetBackgroundTap(distance: number, elapsed: number) {
  return distance <= 8 && elapsed >= 0 && elapsed <= 500
}

export function RaidTemplatePointSheet({
  point,
  pointNumber,
  onClose,
  onConfirm,
  onDelete,
  onHeightChange,
  onUpdate,
}: {
  point: DraftRaidTemplatePoint
  pointNumber: number
  onClose: () => void
  onConfirm: () => void
  onDelete: () => void
  onHeightChange: (height: number) => void
  onUpdate: (patch: Partial<Pick<DraftRaidTemplatePoint, 'name' | 'address' | 'comment' | 'labelsConfirmed'>>) => void
}) {
  const sheetRef = useRef<HTMLElement>(null)
  const commentRef = useRef<HTMLTextAreaElement>(null)
  const dragRef = useRef<{ pointerId: number; startY: number; currentY: number; startHeight: number; maxHeight: number } | null>(null)
  const onCloseRef = useRef(onClose)
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closingRef = useRef(false)
  const draggedHandle = useRef(false)
  const [dragOffset, setDragOffset] = useState(0)
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [closing, setClosing] = useState(false)
  onCloseRef.current = onClose

  const resizeComment = useCallback(() => {
    const field = commentRef.current
    if (!field) return
    const previousHeight = field.offsetHeight
    field.style.height = '0px'
    const style = getComputedStyle(field)
    const naturalHeight = field.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
    const height = Math.min(240, Math.max(46, naturalHeight))
    field.style.height = `${height}px`
    field.style.overflowY = naturalHeight > height ? 'auto' : 'hidden'
    const content = field.closest<HTMLElement>('.rt-point-sheet__body')
    if (content && height > previousHeight && document.activeElement === field && field.selectionEnd === field.value.length) {
      // Reveal new lines inside the form, never by scrolling the page.
      content.scrollTop += Math.max(0, field.getBoundingClientRect().bottom - content.getBoundingClientRect().bottom)
    }
  }, [])

  useLayoutEffect(resizeComment, [point.comment, resizeComment])
  useLayoutEffect(() => {
    const field = commentRef.current
    if (!field) return
    let width = field.clientWidth
    const observer = new ResizeObserver(() => {
      if (width === field.clientWidth) return
      width = field.clientWidth
      resizeComment()
    })
    observer.observe(field)
    return () => observer.disconnect()
  }, [resizeComment])

  const close = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    dragRef.current = null
    setDragging(false)
    setClosing(true)
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    exitTimer.current = setTimeout(() => onCloseRef.current(), reducedMotion ? 0 : POINT_SHEET_EXIT_DURATION)
  }, [])

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    sheetRef.current?.focus({ preventScroll: true })
    document.body.classList.add('rt-point-sheet-open')
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    let backgroundTouch: { pointerId: number; x: number; y: number; time: number; distance: number } | null = null
    const isBackground = (target: EventTarget | null) => target instanceof Element
      && !target.closest('.rt-point-sheet, .rt-map__controls, .rp-waypoint, button, a')
    const startBackgroundTap = (event: PointerEvent) => {
      // A second finger belongs to a map pinch, never to a dismissing tap.
      if (backgroundTouch || !event.isPrimary || event.button !== 0 || !isBackground(event.target)) {
        backgroundTouch = null
        return
      }
      backgroundTouch = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, distance: 0 }
    }
    const moveBackgroundTap = (event: PointerEvent) => {
      if (!backgroundTouch || backgroundTouch.pointerId !== event.pointerId) return
      backgroundTouch.distance = Math.max(backgroundTouch.distance, Math.hypot(event.clientX - backgroundTouch.x, event.clientY - backgroundTouch.y))
    }
    const finishBackgroundTap = (event: PointerEvent) => {
      const touch = backgroundTouch
      backgroundTouch = null
      if (!touch || touch.pointerId !== event.pointerId || !isBackground(event.target)) return
      const distance = Math.max(touch.distance, Math.hypot(event.clientX - touch.x, event.clientY - touch.y))
      if (isPointSheetBackgroundTap(distance, event.timeStamp - touch.time)) close()
    }
    const cancelBackgroundTap = () => { backgroundTouch = null }
    window.addEventListener('keydown', handleKeyboard)
    document.addEventListener('pointerdown', startBackgroundTap, true)
    document.addEventListener('pointermove', moveBackgroundTap, true)
    document.addEventListener('pointerup', finishBackgroundTap, true)
    document.addEventListener('pointercancel', cancelBackgroundTap, true)
    return () => {
      if (exitTimer.current !== null) clearTimeout(exitTimer.current)
      window.removeEventListener('keydown', handleKeyboard)
      document.removeEventListener('pointerdown', startBackgroundTap, true)
      document.removeEventListener('pointermove', moveBackgroundTap, true)
      document.removeEventListener('pointerup', finishBackgroundTap, true)
      document.removeEventListener('pointercancel', cancelBackgroundTap, true)
      document.body.classList.remove('rt-point-sheet-open')
      opener?.focus({ preventScroll: true })
    }
  }, [close])

  usePointSheetViewport(sheetRef, onHeightChange)

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (closingRef.current || (event.pointerType === 'mouse' && event.button !== 0)) return
    const sheet = sheetRef.current
    if (!sheet) return
    const startHeight = sheet.getBoundingClientRect().height
    const maxHeight = Math.max(startHeight, (sheet.parentElement?.getBoundingClientRect().height ?? window.innerHeight) - 12)
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, currentY: event.clientY, startHeight, maxHeight }
    draggedHandle.current = false
    setDragHeight(startHeight)
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.currentY = event.clientY
    const distance = event.clientY - drag.startY
    if (Math.abs(distance) > 8) draggedHandle.current = true
    setDragOffset(Math.max(0, distance))
    setDragHeight(Math.min(drag.maxHeight, drag.startHeight + Math.max(0, -distance)))
  }

  const finishDrag = (event: ReactPointerEvent<HTMLElement>, allowDismiss: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setDragging(false)
    if (allowDismiss && shouldDismissPointSheet(drag.startY, drag.currentY)) {
      close()
      return
    }
    if (allowDismiss && shouldExpandPointSheet(drag.startY, drag.currentY)) setExpanded(true)
    setDragOffset(0)
    setDragHeight(null)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!point.name.trim()) return
    onConfirm()
  }

  const sheetStyle = {
    '--rt-point-sheet-drag': `${dragOffset}px`,
    ...(dragHeight === null ? {} : { height: `${dragHeight}px` }),
  } as CSSProperties

  return <div className="rt-point-sheet-backdrop" role="presentation">
    <section
      aria-labelledby="rt-point-sheet-title"
      className={`rt-point-sheet${dragging ? ' rt-point-sheet--dragging' : ''}${expanded ? ' rt-point-sheet--expanded' : ''}${closing ? ' rt-point-sheet--closing' : ''}`}
      ref={sheetRef}
      role="dialog"
      style={sheetStyle}
      tabIndex={-1}
    >
      <header
        aria-label={`Точка ${pointNumber}. Потяните вверх, чтобы развернуть, или вниз, чтобы закрыть`}
        aria-expanded={expanded}
        className="rt-point-sheet__handle"
        onClick={() => { if (!draggedHandle.current && !closingRef.current) setExpanded(true) }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); close() }
          else if (event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setExpanded(true) }
        }}
        onLostPointerCapture={(event) => finishDrag(event, false)}
        onPointerCancel={(event) => finishDrag(event, false)}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={(event) => finishDrag(event, true)}
        role="button"
        tabIndex={0}
      >
        <span aria-hidden="true" className="rt-point-sheet__grabber" />
        <div className="rt-point-sheet__title-row">
          <h2 id="rt-point-sheet-title">Точка {pointNumber}</h2>
        </div>
      </header>
      <form onSubmit={submit}>
        <div className="rt-point-sheet__body">
          {point.geocodeStatus === 'pending' && <p className="rt-point-sheet__hint">Определяем название и адрес…</p>}
        <label htmlFor="rt-point-name">Название точки</label>
        <input
          autoComplete="off"
          id="rt-point-name"
          maxLength={120}
          onChange={(event) => onUpdate({ name: event.target.value, labelsConfirmed: false })}
          required
          value={point.name}
        />
        <div className="rt-point-sheet__field-head">
          <label htmlFor="rt-point-address">Адрес <span>Необязательно</span></label>
          <a className="rt-point-sheet__attribution" href="https://www.openstreetmap.org/copyright" rel="noreferrer" target="_blank">
            © OpenStreetMap
          </a>
        </div>
        <input
          autoComplete="street-address"
          id="rt-point-address"
          maxLength={240}
          onChange={(event) => onUpdate({ address: event.target.value, labelsConfirmed: false })}
          placeholder="Можно оставить пустым"
          value={point.address}
        />
        <label htmlFor="rt-point-comment">Комментарий</label>
        <textarea
          ref={commentRef}
          id="rt-point-comment"
          maxLength={500}
          onChange={(event) => onUpdate({ comment: event.target.value })}
          placeholder="Ориентир или заметка"
          rows={1}
          value={point.comment}
        />
        </div>
        <div className="rt-point-sheet__actions">
          <button className="rt-point-sheet__confirm" disabled={!point.name.trim()} type="submit">
            {point.labelsConfirmed ? 'Готово' : 'Подтвердить'}
          </button>
          <button aria-label={`Удалить точку ${pointNumber}`} className="rt-point-sheet__delete" onClick={onDelete} type="button">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" /></svg>
          </button>
        </div>
      </form>
    </section>
  </div>
}
