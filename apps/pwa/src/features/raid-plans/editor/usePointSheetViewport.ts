import { useLayoutEffect, type RefObject } from 'react'
import { pointSheetViewport } from './point-sheet-viewport'

/** Keep the sheet over the keyboard and scroll only its fields, never the page. */
export function usePointSheetViewport(ref: RefObject<HTMLElement | null>, onHeightChange: (height: number) => void) {
  useLayoutEffect(() => {
    const sheet = ref.current
    const shell = sheet?.closest<HTMLElement>('.rt-editor-shell')
    if (!sheet || !shell) return
    const viewport = window.visualViewport
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const body = document.body
    const root = document.documentElement
    const bodyProperties = ['position', 'top', 'left', 'right', 'width', 'overflow'] as const
    const previous = bodyProperties.map(property => [property, body.style.getPropertyValue(property)] as const)
    const rootOverflow = root.style.overflow
    body.style.position = 'fixed'
    body.style.top = `${-scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'
    body.style.overflow = 'hidden'
    root.style.overflow = 'hidden'
    let frame = 0

    const revealField = () => {
      const focused = document.activeElement
      const content = sheet.querySelector<HTMLElement>('.rt-point-sheet__body')
      if (!content || !(focused instanceof HTMLElement) || !content.contains(focused)) return
      const fieldRect = focused.getBoundingClientRect()
      const contentRect = content.getBoundingClientRect()
      if (fieldRect.bottom > contentRect.bottom - 8) content.scrollTop += fieldRect.bottom - contentRect.bottom + 8
      else if (fieldRect.top < contentRect.top + 8) content.scrollTop -= contentRect.top - fieldRect.top + 8
    }
    const fit = () => {
      const geometry = pointSheetViewport(window.innerHeight, viewport)
      shell.style.setProperty('--rt-viewport-top', `${geometry.top}px`)
      shell.style.setProperty('--rt-viewport-height', `${geometry.height}px`)
      shell.style.setProperty('--rt-sheet-max-height', `${geometry.maxSheetHeight}px`)
      onHeightChange(Math.ceil(sheet.getBoundingClientRect().height))
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(revealField)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(sheet)
    viewport?.addEventListener('resize', fit)
    viewport?.addEventListener('scroll', fit)
    window.addEventListener('resize', fit)
    sheet.addEventListener('focusin', fit)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      viewport?.removeEventListener('resize', fit)
      viewport?.removeEventListener('scroll', fit)
      window.removeEventListener('resize', fit)
      sheet.removeEventListener('focusin', fit)
      for (const property of ['--rt-viewport-top', '--rt-viewport-height', '--rt-sheet-max-height']) shell.style.removeProperty(property)
      for (const [property, value] of previous) body.style.setProperty(property, value)
      root.style.overflow = rootOverflow
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' })
      onHeightChange(0)
    }
  }, [ref, onHeightChange])
}
