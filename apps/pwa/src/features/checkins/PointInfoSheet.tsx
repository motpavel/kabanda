import { useEffect, useRef, type ReactNode } from 'react'
import { useSlideSheet } from '../raids/recording/useSlideSheet'
import './point-info-sheet.css'

export function PointInfoSheet({ open, onClose, title, pointKey, kicker, distance, children, footer, className = '' }: {
  open: boolean; onClose: () => void; title: string; pointKey?: string; kicker?: string;
  distance?: { value: string | number; unit: string } | null; children: ReactNode; footer?: ReactNode; className?: string
}) {
  const sheet = useSlideSheet<HTMLElement>(open, onClose)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => { if (open) body.current?.scrollTo({ top: 0 }) }, [pointKey, title, open])
  return <aside {...sheet} className={`raid-arrival-sheet raid-point-history-sheet point-info-sheet ${className}`} aria-label={`Точка: ${title}`} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
    <button className="raid-arrival-sheet__collapse" data-sheet-drag="true" aria-label="Свернуть точку" onClick={onClose} type="button"><span /></button>
    <div className="raid-arrival-sheet__heading" data-sheet-drag="true">
      <div>{kicker && <small>{kicker}</small>}<h2>{title}</h2></div>
      {distance && <span className="raid-arrival-sheet__distance">{distance.value}<small>{distance.unit}</small></span>}
    </div>
    <div ref={body} className="raid-arrival-sheet__body">{children}</div>
    {footer && <div className="raid-arrival-sheet__footer">{footer}</div>}
  </aside>
}
