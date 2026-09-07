import { useEffect, useRef } from 'react'

/** Keep the recording tree mounted when a browser cannot lock phone orientation. */
export function PortraitMode() {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const phone = matchMedia('(pointer: coarse) and (max-height: 600px) and (orientation: landscape)')
    const update = () => {
      const element = dialog.current
      if (!element) return
      const orientation = screen.orientation?.type
      const landscape = phone.matches && (!orientation || orientation.startsWith('landscape'))
      if (landscape && !element.open) element.showModal()
      else if (!landscape && element.open) element.close()
    }
    const tryLock = () => {
      if (!matchMedia('(pointer: coarse)').matches) return
      const orientation = screen.orientation as ScreenOrientation & { lock?: (value: string) => Promise<void> }
      void orientation?.lock?.('portrait-primary').catch(() => undefined)
    }
    tryLock()
    update()
    phone.addEventListener('change', update)
    screen.orientation?.addEventListener('change', update)
    document.addEventListener('fullscreenchange', tryLock)
    window.addEventListener('pageshow', tryLock)
    return () => {
      phone.removeEventListener('change', update)
      screen.orientation?.removeEventListener('change', update)
      document.removeEventListener('fullscreenchange', tryLock)
      window.removeEventListener('pageshow', tryLock)
      dialog.current?.close()
    }
  }, [])
  return <dialog ref={dialog} className="portrait-mode" aria-labelledby="portrait-mode-title" onCancel={(event) => event.preventDefault()}>
    <div><svg aria-hidden="true" viewBox="0 0 48 64" width="48" height="64" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="9" y="3" width="30" height="58" rx="7"/><path d="M20 53h8"/></svg><h2 id="portrait-mode-title">Поверните телефон вертикально</h2><p>Кабанда работает в вертикальном режиме.</p></div>
  </dialog>
}
