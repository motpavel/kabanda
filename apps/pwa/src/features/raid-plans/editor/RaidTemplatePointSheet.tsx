import { useEffect, useRef, type FormEvent } from 'react'
import type { DraftRaidTemplatePoint } from '../types'

export function RaidTemplatePointSheet({
  point,
  pointNumber,
  onClose,
  onConfirm,
  onDelete,
  onRetryGeocode,
  onUpdate,
}: {
  point: DraftRaidTemplatePoint
  pointNumber: number
  onClose: () => void
  onConfirm: () => void
  onDelete: () => void
  onRetryGeocode: () => void
  onUpdate: (patch: Partial<Pick<DraftRaidTemplatePoint, 'name' | 'address' | 'comment' | 'labelsConfirmed'>>) => void
}) {
  const nameRef = useRef<HTMLInputElement>(null)
  const sheetRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    nameRef.current?.focus({ preventScroll: true })
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
      opener?.focus({ preventScroll: true })
    }
  }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!point.name.trim() || !point.address.trim()) return
    onConfirm()
  }

  return <div className="rt-point-sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section aria-labelledby="rt-point-sheet-title" aria-modal="true" className="rt-point-sheet" ref={sheetRef} role="dialog">
      <span aria-hidden="true" className="rt-point-sheet__grabber" />
      <header>
        <div>
          <span>Точка {pointNumber}</span>
          <h2 id="rt-point-sheet-title">Проверьте место</h2>
        </div>
        <button aria-label="Закрыть карточку точки" className="rt-point-sheet__close" onClick={onClose} type="button">×</button>
      </header>
      <p className="rt-point-sheet__hint">
        {point.geocodeStatus === 'pending' && 'Ищем название и адрес. Можно заполнить их вручную.'}
        {point.geocodeStatus === 'ready' && 'Сервис адресов предложил подписи. Проверьте их перед сохранением.'}
        {point.geocodeStatus === 'failed' && <>Сервис адресов не нашёл место. Заполните его вручную или <button onClick={onRetryGeocode} type="button">повторите поиск</button>.</>}
      </p>
      <form onSubmit={submit}>
        <label htmlFor="rt-point-name">Название точки</label>
        <input
          autoComplete="off"
          id="rt-point-name"
          maxLength={120}
          onChange={(event) => onUpdate({ name: event.target.value, labelsConfirmed: false })}
          ref={nameRef}
          required
          value={point.name}
        />
        <label htmlFor="rt-point-address">Адрес</label>
        <input
          autoComplete="street-address"
          id="rt-point-address"
          maxLength={240}
          onChange={(event) => onUpdate({ address: event.target.value, labelsConfirmed: false })}
          required
          value={point.address}
        />
        <a className="rt-point-sheet__attribution" href="https://www.openstreetmap.org/copyright" rel="noreferrer" target="_blank">
          Адреса © OpenStreetMap contributors
        </a>
        <label htmlFor="rt-point-comment">Комментарий <span>необязательно</span></label>
        <textarea
          id="rt-point-comment"
          maxLength={500}
          onChange={(event) => onUpdate({ comment: event.target.value })}
          placeholder="Что здесь сделать или на что обратить внимание"
          rows={3}
          value={point.comment}
        />
        <button className="rt-point-sheet__confirm" disabled={!point.name.trim() || !point.address.trim()} type="submit">
          {point.labelsConfirmed ? 'Подтверждено' : 'Подтвердить название и адрес'}
        </button>
        <button className="rt-point-sheet__delete" onClick={onDelete} type="button">Удалить точку</button>
      </form>
    </section>
  </div>
}
