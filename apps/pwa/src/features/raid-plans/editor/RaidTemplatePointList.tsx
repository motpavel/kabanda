import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { DraftRaidTemplatePoint } from '../types'

export function RaidTemplatePointList({
  points,
  selectedPointId,
  onDelete,
  onMove,
  onReorder,
  onSelect,
}: {
  points: readonly DraftRaidTemplatePoint[]
  selectedPointId: string | null
  onDelete: (pointId: string) => void
  onMove: (pointId: string, direction: -1 | 1) => void
  onReorder: (activeId: string, overId: string) => void
  onSelect: (pointId: string) => void
}) {
  const activeIdRef = useRef<string | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)

  const startDrag = (pointId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    activeIdRef.current = pointId
    setDraggedId(pointId)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const drag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const activeId = activeIdRef.current
    if (!activeId) return
    const element = document.elementFromPoint(event.clientX, event.clientY)
    const item = element?.closest<HTMLElement>('[data-template-point-id]')
    const overId = item?.dataset.templatePointId
    if (overId && overId !== activeId) onReorder(activeId, overId)
  }

  const stopDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    activeIdRef.current = null
    setDraggedId(null)
  }

  if (points.length === 0) {
    return <div className="rt-editor__points-empty">
      <strong>Точек пока нет</strong>
      <span>Коснитесь карты, чтобы поставить первую точку маршрута.</span>
    </div>
  }

  return <ol className="rt-point-list" aria-label="Порядок точек маршрута">
    {points.map((point, index) => (
      <li
        className={`rt-point-card${selectedPointId === point.clientId ? ' rt-point-card--selected' : ''}${draggedId === point.clientId ? ' rt-point-card--dragged' : ''}`}
        data-template-point-id={point.clientId}
        key={point.clientId}
      >
        <button
          aria-label={`Перетащить точку ${index + 1}: ${point.name || 'без названия'}`}
          className="rt-point-card__drag"
          onPointerCancel={stopDrag}
          onPointerDown={(event) => startDrag(point.clientId, event)}
          onPointerMove={drag}
          onPointerUp={stopDrag}
          type="button"
        >
          <span aria-hidden="true">⠿</span>
        </button>
        <button className="rt-point-card__main" onClick={() => onSelect(point.clientId)} type="button">
          <span className="rt-point-card__number" aria-hidden="true">{index + 1}</span>
          <span className="rt-point-card__copy">
            <strong>{point.name.trim() || `Точка ${index + 1}`}</strong>
            <small>{point.address.trim() || geocodeLabel(point.geocodeStatus)}</small>
            {point.comment.trim() && <em>{point.comment}</em>}
          </span>
          <span className={`rt-point-card__state${point.labelsConfirmed ? ' rt-point-card__state--confirmed' : ''}`}>
            {point.labelsConfirmed ? 'Проверено' : 'Проверьте'}
          </span>
        </button>
        <span className="rt-point-card__actions">
          <button aria-label={`Поднять точку ${index + 1} выше`} disabled={index === 0} onClick={() => onMove(point.clientId, -1)} type="button">↑</button>
          <button aria-label={`Опустить точку ${index + 1} ниже`} disabled={index === points.length - 1} onClick={() => onMove(point.clientId, 1)} type="button">↓</button>
          <button aria-label={`Удалить точку ${index + 1}`} className="rt-point-card__delete" onClick={() => onDelete(point.clientId)} type="button">×</button>
        </span>
      </li>
    ))}
  </ol>
}

function geocodeLabel(status: DraftRaidTemplatePoint['geocodeStatus']): string {
  if (status === 'pending') return 'Определяем адрес…'
  if (status === 'failed') return 'Адрес нужно ввести вручную'
  return 'Добавьте адрес'
}
