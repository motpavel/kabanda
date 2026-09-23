import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { DraftRaidTemplatePoint } from '../types'
import { usePointSheetViewport } from './usePointSheetViewport'

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
    }
    window.addEventListener('keydown', handleKeyboard)
    return () => {
      window.removeEventListener('keydown', handleKeyboard)
      document.body.classList.remove('rt-point-sheet-open')
      opener?.focus({ preventScroll: true })
    }
  }, [])

  usePointSheetViewport(sheetRef, onHeightChange)

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
    if (!point.name.trim()) return
    onConfirm()
  }

  const sheetStyle = { '--rt-point-sheet-drag': `${dragOffset}px` } as CSSProperties

  return <div className="rt-point-sheet-backdrop" role="presentation">
    <section
      aria-labelledby="rt-point-sheet-title"
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
        <div className="rt-point-sheet__title-row">
          <h2 id="rt-point-sheet-title">Точка {pointNumber}</h2>
          <button aria-label="Закрыть точку" className="rt-point-sheet__close" onPointerDown={(event) => event.stopPropagation()} onClick={onClose} type="button">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6" /></svg>
          </button>
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
