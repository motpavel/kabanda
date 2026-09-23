import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { DraftRaidTemplatePoint } from '../types'

export function RaidTemplatePointList({
  points,
  selectedPointId,
  onMove,
  onReorder,
  onSelect,
}: {
  points: readonly DraftRaidTemplatePoint[]
  selectedPointId: string | null
  onMove: (pointId: string, direction: -1 | 1) => void
  onReorder: (activeId: string, overId: string) => void
  onSelect: (pointId: string) => void
}) {
  const activeIdRef = useRef<string | null>(null)
  const pointerRef = useRef({ x: 0, y: 0 })
  const frameRef = useRef<number | null>(null)
  const latestRef = useRef({ points, onReorder })
  latestRef.current = { points, onReorder }
  const [announcement, setAnnouncement] = useState('')
  const [draggedId, setDraggedId] = useState<string | null>(null)

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
  }, [])

  const reorderAtPointer = () => {
    const activeId = activeIdRef.current
    if (!activeId) return
    const { x, y } = pointerRef.current
    const item = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-template-point-id]')
    const overId = item?.dataset.templatePointId
    if (!item || !overId || overId === activeId) return
    const { points: current, onReorder: reorder } = latestRef.current
    const from = current.findIndex(point => point.clientId === activeId)
    const to = current.findIndex(point => point.clientId === overId)
    const rect = item.getBoundingClientRect()
    const middle = rect.top + rect.height / 2
    if ((from < to && y < middle) || (from > to && y > middle)) return
    reorder(activeId, overId)
  }

  const scrollWhileDragging = () => {
    if (!activeIdRef.current) return
    const y = pointerRef.current.y
    const edge = 100
    const distance = y < edge ? -Math.min(12, (edge - y) / 5)
      : y > innerHeight - edge ? Math.min(12, (y - innerHeight + edge) / 5) : 0
    if (distance) {
      window.scrollBy(0, distance)
      reorderAtPointer()
    }
    frameRef.current = requestAnimationFrame(scrollWhileDragging)
  }

  const startDrag = (pointId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    activeIdRef.current = pointId
    pointerRef.current = { x: event.clientX, y: event.clientY }
    setDraggedId(pointId)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(scrollWhileDragging)
  }

  const drag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    pointerRef.current = { x: event.clientX, y: event.clientY }
    reorderAtPointer()
  }

  const stopDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const activeId = activeIdRef.current
    activeIdRef.current = null
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setDraggedId(null)
    const index = latestRef.current.points.findIndex(point => point.clientId === activeId)
    if (index >= 0) setAnnouncement(`${latestRef.current.points[index]!.name}. Позиция ${index + 1} из ${latestRef.current.points.length}.`)
  }

  if (points.length === 0) {
    return <div className="rt-editor__points-empty">
      <strong>Точек пока нет</strong>
      <span>Коснитесь карты, чтобы поставить первую точку маршрута.</span>
    </div>
  }

  return <>
    <span id="rt-reorder-keyboard-hint" className="rt-sr-only">Для изменения порядка с клавиатуры используйте стрелки вверх и вниз.</span>
    <span className="rt-sr-only" role="status">{announcement}</span>
    <ol className="rt-point-list" aria-label="Порядок точек маршрута">
    {points.map((point, index) => (
      <li
        className={`rt-point-card${selectedPointId === point.clientId ? ' rt-point-card--selected' : ''}${draggedId === point.clientId ? ' rt-point-card--dragged' : ''}`}
        data-template-point-id={point.clientId}
        key={point.clientId}
      >
        <button className="rt-point-card__main" onClick={() => onSelect(point.clientId)} type="button">
          <span className="rt-point-card__number" aria-hidden="true">{index + 1}</span>
          <span className="rt-point-card__copy">
            <strong>{point.name.trim() || `Точка ${index + 1}`}</strong>
            <small>{point.address.trim() || geocodeLabel(point.geocodeStatus)}</small>
            {point.comment.trim() && <em>{point.comment}</em>}
            {!point.labelsConfirmed && <em className="rt-point-card__needs-review">Проверьте название и адрес</em>}
          </span>
        </button>
        <button
          aria-label={`Перетащить точку ${index + 1}: ${point.name || 'без названия'}`}
          className="rt-point-card__drag"
          aria-describedby="rt-reorder-keyboard-hint"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            const direction = event.key === 'ArrowUp' ? -1 : 1
            const next = index + direction
            if (next < 0 || next >= points.length) return
            onMove(point.clientId, direction)
            setAnnouncement(`${point.name}. Позиция ${next + 1} из ${points.length}.`)
          }}
          onPointerCancel={stopDrag}
          onLostPointerCapture={stopDrag}
          onPointerDown={(event) => startDrag(point.clientId, event)}
          onPointerMove={drag}
          onPointerUp={stopDrag}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
        </button>
      </li>
    ))}
    </ol>
  </>
}

function geocodeLabel(status: DraftRaidTemplatePoint['geocodeStatus']): string {
  if (status === 'pending') return 'Определяем адрес…'
  if (status === 'failed') return 'Адрес нужно ввести вручную'
  return 'Добавьте адрес'
}
