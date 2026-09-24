import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
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
  const listRef = useRef<HTMLOListElement>(null)
  const dragRef = useRef<{
    id: string; startY: number; scrollY: number; currentY: number; target: number;
    rows: Array<{ id: string; top: number; height: number }>; gap: number;
  } | null>(null)
  const frameRef = useRef<number | null>(null)
  const beforeRects = useRef(new Map<string, number>())
  const latestRef = useRef({ points, onReorder })
  latestRef.current = { points, onReorder }
  const [announcement, setAnnouncement] = useState('')
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [offsets, setOffsets] = useState<Record<string, number>>({})

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
  }, [])

  const rememberPositions = () => {
    beforeRects.current.clear()
    listRef.current?.querySelectorAll<HTMLElement>('[data-template-point-id]').forEach(row => {
      beforeRects.current.set(row.dataset.templatePointId!, row.getBoundingClientRect().top)
    })
  }

  useLayoutEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    listRef.current?.querySelectorAll<HTMLElement>('[data-template-point-id]').forEach(row => {
      const before = beforeRects.current.get(row.dataset.templatePointId!)
      if (before === undefined || reduced) return
      const delta = before - row.getBoundingClientRect().top
      if (Math.abs(delta) > 1) row.animate([
        { transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' },
      ], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' })
    })
    beforeRects.current.clear()
  }, [points, draggedId])

  const updateDrag = () => {
    const current = dragRef.current
    if (!current) return
    const from = current.rows.findIndex(row => row.id === current.id)
    const active = current.rows[from]!
    const dy = current.currentY - current.startY + window.scrollY - current.scrollY
    const center = active.top + active.height / 2 + dy
    let target = from
    current.rows.forEach((row, index) => {
      if (index > from && center > row.top + row.height / 2) target = index
      if (index < from && center < row.top + row.height / 2) target = Math.min(target, index)
    })
    current.target = target
    const order = [...current.rows]
    order.splice(from, 1)
    order.splice(target, 0, active)
    let top = current.rows[0]!.top
    const next: Record<string, number> = {}
    for (const row of order) {
      next[row.id] = row.id === current.id ? dy : top - row.top
      top += row.height + current.gap
    }
    setOffsets(next)
  }

  const scrollWhileDragging = () => {
    const current = dragRef.current
    if (!current) return
    const y = current.currentY
    const edge = 100
    const distance = y < edge ? -Math.min(12, (edge - y) / 5)
      : y > innerHeight - edge ? Math.min(12, (y - innerHeight + edge) / 5) : 0
    if (distance) { window.scrollBy(0, distance); updateDrag() }
    frameRef.current = requestAnimationFrame(scrollWhileDragging)
  }

  const startDrag = (pointId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-template-point-id]') ?? []).map(row => {
      row.getAnimations().forEach(animation => animation.cancel())
      const rect = row.getBoundingClientRect()
      return { id: row.dataset.templatePointId!, top: rect.top, height: rect.height }
    })
    dragRef.current = {
      id: pointId, startY: event.clientY, currentY: event.clientY, scrollY: window.scrollY,
      rows, target: rows.findIndex(row => row.id === pointId),
      gap: parseFloat(getComputedStyle(listRef.current!).rowGap) || 0,
    }
    setDraggedId(pointId)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    frameRef.current = requestAnimationFrame(scrollWhileDragging)
  }

  const drag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return
    dragRef.current.currentY = event.clientY
    updateDrag()
  }

  const stopDrag = (event: ReactPointerEvent<HTMLButtonElement>, commit = true) => {
    const current = dragRef.current
    if (!current) return
    rememberPositions()
    dragRef.current = null
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (commit) {
      const overId = current.rows[current.target]?.id
      if (overId && overId !== current.id) latestRef.current.onReorder(current.id, overId)
      setAnnouncement(`Точка перемещена на позицию ${current.target + 1} из ${current.rows.length}.`)
    }
    setOffsets({})
    setDraggedId(null)
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
    <ol ref={listRef} className="rt-point-list" aria-label="Порядок точек маршрута">
    {points.map((point, index) => (
      <li
        className={`rt-point-card${selectedPointId === point.clientId ? ' rt-point-card--selected' : ''}${draggedId === point.clientId ? ' rt-point-card--dragged' : ''}`}
        style={{ transform: offsets[point.clientId] === undefined ? undefined : `translateY(${offsets[point.clientId]}px)${draggedId === point.clientId ? ' scale(1.025)' : ''}`, transition: draggedId === point.clientId ? 'none' : undefined }}
        data-template-point-id={point.clientId}
        key={point.clientId}
      >
        <button className="rt-point-card__main" onClick={() => onSelect(point.clientId)} type="button">
          <span className="rt-point-card__number" aria-hidden="true">{index + 1}</span>
          <span className="rt-point-card__copy">
            <strong>{point.name.trim() || `Точка ${index + 1}`}</strong>
            <small>{point.address.trim() || 'Точка на карте'}</small>
            {point.comment.trim() && <em>{point.comment}</em>}
            {!point.labelsConfirmed && <em className="rt-point-card__needs-review">Проверьте точку</em>}
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
            rememberPositions()
            onMove(point.clientId, direction)
            setAnnouncement(`${point.name}. Позиция ${next + 1} из ${points.length}.`)
          }}
          onPointerCancel={(event) => stopDrag(event, false)}
          onLostPointerCapture={(event) => stopDrag(event, false)}
          onPointerDown={(event) => startDrag(point.clientId, event)}
          onPointerMove={drag}
          onPointerUp={(event) => stopDrag(event)}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
        </button>
      </li>
    ))}
    </ol>
  </>
}
