import { useEffect, type ReactNode } from 'react'
import { useSlideSheet } from '../raids/recording/useSlideSheet'
import './point-info-sheet.css'

export function PointInfoSheet({ open, onClose, title, kicker, distance, children, className = '' }: {
  open: boolean; onClose: () => void; title: string; kicker?: string;
  distance?: { value: string | number; unit: string } | null; children: ReactNode; className?: string
}) {
  const sheet = useSlideSheet<HTMLElement>(open, onClose)
  useEffect(() => { sheet.ref.current?.scrollTo({ top: 0 }) }, [title, sheet.ref])
  return <aside {...sheet} className={`raid-arrival-sheet raid-point-history-sheet point-info-sheet ${className}`} aria-label={`История точки: ${title}`} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
    <button className="raid-arrival-sheet__collapse" data-sheet-drag="true" aria-label="Свернуть историю точки" onClick={onClose} type="button"><span /></button>
    <div className="raid-arrival-sheet__heading" data-sheet-drag="true">
      <div>{kicker && <small>{kicker}</small>}<h2>{title}</h2></div>
      {distance && <span className="raid-arrival-sheet__distance">{distance.value}<small>{distance.unit}</small></span>}
    </div>
    {children}
  </aside>
}
