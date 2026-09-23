import { useId, useState } from 'react'
import './point-materials-hint.css'

export function PointMaterialsHint() {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <span className="point-materials-hint">
    <button type="button" aria-label="Когда можно добавить фото и комментарии" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>ⓘ</button>
    {open && <span id={id} role="note">Фото и комментарии можно добавить после вашей подтверждённой отметки на этой точке в рейде.</span>}
  </span>
}
