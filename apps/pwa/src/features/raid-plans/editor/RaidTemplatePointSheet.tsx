import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { DraftRaidTemplatePoint } from '../types'

const POINT_SHEET_DISMISS_DISTANCE = 72

export function shouldDismissPointSheet(startY: number, currentY: number) {
  return currentY - startY >= POINT_SHEET_DISMISS_DISTANCE
}

export function RaidTemplatePointSheet({
  point,
  pointNumber,
  onClose,
  onConfirm,
  onDelete,
  onHeightChange,
  onRetryGeocode,
  onUpdate,
}: {
  point: DraftRaidTemplatePoint
  pointNumber: number
  onClose: () => void
  onConfirm: () => void
  onDelete: () => void
  onHeightChange: (height: number) => void
  onRetryGeocode: () => void
  onUpdate: (patch: Partial<Pick<DraftRaidTemplatePoint, 'name' | 'address' | 'comment' | 'labelsConfirmed'>>) => void
}) {
  const sheetRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{ pointerId: number; startY: number; currentY: number } | null>(null)
  const onCloseRef = useRef(onClose)
  const [dragOffset, setDragOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  onCloseRef.current = onClose

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    sheetRef.current?.focus({ preventScroll: true })
    document.body.classList.add('rt-point-sheet-open')
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
      if (event.key !== 'Tab') return
      const focusable = sheetRef.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyboard)
    return () => {
      window.removeEventListener('keydown', handleKeyboard)
      document.body.classList.remove('rt-point-sheet-open')
      opener?.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const sheet = sheetRef.current
    if (!sheet) return
    const reportHeight = () => onHeightChange(Math.ceil(sheet.getBoundingClientRect().height))
    reportHeight()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reportHeight)
    observer?.observe(sheet)
    window.visualViewport?.addEventListener('resize', reportHeight)
    return () => {
      observer?.disconnect()
      window.visualViewport?.removeEventListener('resize', reportHeight)
      onHeightChange(0)
    }
  }, [onHeightChange])

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, currentY: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.currentY = event.clientY
    setDragOffset(Math.max(0, event.clientY - drag.startY))
  }

  const finishDrag = (event: ReactPointerEvent<HTMLElement>, allowDismiss: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    dragRef.current = null
    setDragging(false)
    if (allowDismiss && shouldDismissPointSheet(drag.startY, drag.currentY)) {
      onCloseRef.current()
      return
    }
    setDragOffset(0)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!point.name.trim() || !point.address.trim()) return
    onConfirm()
  }

  const sheetStyle = { '--rt-point-sheet-drag': `${dragOffset}px` } as CSSProperties

  return <div className="rt-point-sheet-backdrop" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section
      aria-labelledby="rt-point-sheet-title"
      aria-modal="true"
      className={`rt-point-sheet${dragging ? ' rt-point-sheet--dragging' : ''}`}
      ref={sheetRef}
      role="dialog"
      style={sheetStyle}
      tabIndex={-1}
    >
      <header
        className="rt-point-sheet__handle"
        onPointerCancel={(event) => finishDrag(event, false)}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={(event) => finishDrag(event, true)}
      >
        <span aria-hidden="true" className="rt-point-sheet__grabber" />
        <h2 id="rt-point-sheet-title">Точка {pointNumber}</h2>
      </header>
      {point.geocodeStatus !== 'ready' && <p className="rt-point-sheet__hint">
        {point.geocodeStatus === 'pending' && 'Определяем название и адрес…'}
        {point.geocodeStatus === 'failed' && <>Адрес не найден. Введите его или <button onClick={onRetryGeocode} type="button">повторите поиск</button>.</>}
      </p>}
      <form onSubmit={submit}>
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
          <label htmlFor="rt-point-address">Адрес</label>
          <a className="rt-point-sheet__attribution" href="https://www.openstreetmap.org/copyright" rel="noreferrer" target="_blank">
            © OpenStreetMap
          </a>
        </div>
        <input
          autoComplete="street-address"
          id="rt-point-address"
          maxLength={240}
          onChange={(event) => onUpdate({ address: event.target.value, labelsConfirmed: false })}
          required
          value={point.address}
        />
        <label htmlFor="rt-point-comment">Комментарий</label>
        <textarea
          id="rt-point-comment"
          maxLength={500}
          onChange={(event) => onUpdate({ comment: event.target.value })}
          placeholder="Что важно знать в этой точке"
          rows={1}
          value={point.comment}
        />
        <div className="rt-point-sheet__actions">
          <button className="rt-point-sheet__confirm" disabled={!point.name.trim() || !point.address.trim()} type="submit">
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
