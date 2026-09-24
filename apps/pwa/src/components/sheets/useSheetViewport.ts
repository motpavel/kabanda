import { useLayoutEffect, type RefObject } from 'react'
import { containSheetScroll } from './sheet-scroll'
import { lockSheetPage } from './sheet-page-lock'
import './sheet-viewport.css'
import { sheetViewport } from './sheet-viewport'

/** Anchor the form to the visible viewport and contain iOS keyboard scrolling. */
export function useSheetViewport(ref: RefObject<HTMLElement | null>, {
  open = true, hostSelector, contentSelector = '[data-sheet-body]', allowMapSelector, onHeightChange, position = 'surface',
}: {
  open?: boolean; hostSelector?: string; contentSelector?: string; allowMapSelector?: string;
  onHeightChange?: (height: number) => void; position?: 'frame' | 'surface';
} = {}) {
  useLayoutEffect(() => {
    const sheet = ref.current
    const shell = hostSelector ? sheet?.closest<HTMLElement>(hostSelector) : sheet
    const content = sheet?.querySelector<HTMLElement>(contentSelector) ?? sheet
    if (!open || !sheet || !shell || !content) return
    const viewport = window.visualViewport
    const root = document.documentElement
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    const page = lockSheetPage(sheet)
    const surfaceProperties = ['position', 'top', 'bottom', 'max-height'] as const
    const previousSurface = surfaceProperties.map(property => [property, sheet.style.getPropertyValue(property)] as const)
    const underlay = position === 'surface' ? document.createElement('div') : null
    if (underlay) {
      underlay.className = 'sheet-keyboard-underlay'
      underlay.setAttribute('aria-hidden', 'true')
      sheet.insertAdjacentElement('afterend', underlay)
      sheet.dataset.fixedSheet = 'true'
    }
    let layoutHeight = Math.max(root.clientHeight, window.innerHeight)
    let layoutWidth = root.clientWidth
    let keyboardOpen = false
    let frame = 0
    let focusFrame = 0
    let blurFrame = 0
    const hiddenFields = new Map<HTMLElement, string>()
    const textField = (target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement =>
      target instanceof HTMLElement && content.contains(target) && target.matches('input, textarea')
    const isEditing = () => textField(document.activeElement)

    const revealField = () => {
      const focused = document.activeElement
      if (!textField(focused)) return
      const fieldRect = focused.getBoundingClientRect()
      const contentRect = content.getBoundingClientRect()
      if (fieldRect.bottom > contentRect.bottom - 8) content.scrollTop += fieldRect.bottom - contentRect.bottom + 8
      else if (fieldRect.top < contentRect.top + 8) content.scrollTop -= contentRect.top - fieldRect.top + 8
    }
    const fit = () => {
      const editing = isEditing()
      if (layoutWidth !== root.clientWidth) {
        // A rotation starts a new layout baseline, including when a field keeps focus.
        layoutWidth = root.clientWidth
        layoutHeight = Math.max(root.clientHeight, window.innerHeight)
        keyboardOpen = false
      }
      // innerHeight can shrink or lag during Safari's keyboard animation. Keep
      // the layout baseline, so its changing value cannot clamp away offsetTop.
      if (!editing && !keyboardOpen) layoutHeight = Math.max(root.clientHeight, window.innerHeight)
      const geometry = sheetViewport(Math.max(layoutHeight, root.clientHeight), viewport ?? { height: window.innerHeight, offsetTop: 0, scale: 1 })
      const inset = layoutHeight - geometry.height
      keyboardOpen = (editing || keyboardOpen) && inset > 100 && (!viewport || Math.abs(viewport.scale - 1) < .01)
      shell.dataset.sheetEditing = String(editing || keyboardOpen)
      shell.dataset.sheetKeyboard = String(keyboardOpen)
      shell.style.setProperty('--sheet-viewport-top', `${geometry.top}px`)
      shell.style.setProperty('--sheet-viewport-height', `${geometry.height}px`)
      shell.style.setProperty('--sheet-max-height', `${geometry.maxSheetHeight}px`)
      shell.style.setProperty('--sheet-expanded-height', `${Math.max(1, geometry.height - 12)}px`)
      shell.style.setProperty('--sheet-safe-bottom', keyboardOpen ? '0px' : 'env(safe-area-inset-bottom)')
      if (position === 'surface') {
        sheet.style.position = 'fixed'
        sheet.style.bottom = 'auto'
        sheet.style.maxHeight = `${Math.max(1, Math.min(680, geometry.height - 24))}px`
        // offsetHeight is not affected by the sheet's entrance/drag transform.
        sheet.style.top = `${Math.max(geometry.top + 12, geometry.top + geometry.height - sheet.offsetHeight)}px`
      }
      if (underlay) {
        underlay.hidden = !(editing || keyboardOpen)
        underlay.style.top = `${geometry.top + geometry.height}px`
        underlay.style.zIndex = getComputedStyle(sheet).zIndex
      }
      onHeightChange?.(Math.ceil(sheet.getBoundingClientRect().height))
    }
    const resize = () => {
      fit()
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(revealField)
    }
    const restoreFields = () => {
      for (const [field, opacity] of hiddenFields) field.style.opacity = opacity
      hiddenFields.clear()
    }
    const prepareFocus = (field: HTMLElement) => {
      // WebKit scrolls even fixed inputs into view on focus. An invisible input
      // does not trigger that pan; restore before paint and reveal only our body.
      if (!isIOS) return
      if (!hiddenFields.has(field)) hiddenFields.set(field, field.style.opacity)
      field.style.opacity = '0'
      cancelAnimationFrame(focusFrame)
      focusFrame = requestAnimationFrame(() => { restoreFields(); resize() })
    }
    let touchStart: { x: number; y: number; target: EventTarget | null; moved: boolean } | null = null
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      touchStart = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY, target: event.target, moved: false } : null
    }
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (touchStart && (event.touches.length !== 1 || (touch && Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) > 8))) touchStart.moved = true
    }
    const onTouchEnd = (event: TouchEvent) => {
      const target = event.target
      if (isIOS && touchStart && !touchStart.moved && touchStart.target === target && textField(target) && target !== document.activeElement) {
        event.preventDefault()
        prepareFocus(target)
        target.focus({ preventScroll: true })
      }
      touchStart = null
    }
    const onFocus = (event: FocusEvent) => {
      if (textField(event.target)) prepareFocus(event.target)
      resize()
    }
    const onBlur = () => {
      cancelAnimationFrame(blurFrame)
      // Wait for the new activeElement when using the keyboard's field arrows.
      blurFrame = requestAnimationFrame(resize)
    }
    const resetRootScroll = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo({ left: 0, top: 0, behavior: 'instant' })
      fit()
    }
    if (textField(document.activeElement)) prepareFocus(document.activeElement)
    resize()
    const releaseScroll = containSheetScroll(sheet, content, () => isEditing() || keyboardOpen, allowMapSelector, page.isTopmost)
    const observer = new ResizeObserver(fit)
    observer.observe(sheet)
    viewport?.addEventListener('resize', resize)
    // A viewport scroll only reanchors the sheet; never override a user's form scroll.
    viewport?.addEventListener('scroll', fit)
    window.addEventListener('resize', resize)
    window.addEventListener('scroll', resetRootScroll)
    sheet.addEventListener('focusin', onFocus)
    sheet.addEventListener('focusout', onBlur)
    sheet.addEventListener('touchstart', onTouchStart, { passive: true })
    sheet.addEventListener('touchmove', onTouchMove, { passive: true })
    sheet.addEventListener('touchend', onTouchEnd, { passive: false })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(focusFrame)
      cancelAnimationFrame(blurFrame)
      restoreFields()
      releaseScroll()
      observer.disconnect()
      viewport?.removeEventListener('resize', resize)
      viewport?.removeEventListener('scroll', fit)
      window.removeEventListener('resize', resize)
      window.removeEventListener('scroll', resetRootScroll)
      sheet.removeEventListener('focusin', onFocus)
      sheet.removeEventListener('focusout', onBlur)
      sheet.removeEventListener('touchstart', onTouchStart)
      sheet.removeEventListener('touchmove', onTouchMove)
      sheet.removeEventListener('touchend', onTouchEnd)
      delete shell.dataset.sheetEditing
      delete shell.dataset.sheetKeyboard
      for (const property of ['--sheet-viewport-top', '--sheet-viewport-height', '--sheet-max-height', '--sheet-expanded-height', '--sheet-safe-bottom']) shell.style.removeProperty(property)
      underlay?.remove()
      if (position === 'surface') {
        delete sheet.dataset.fixedSheet
        for (const [property, value] of previousSurface) sheet.style.setProperty(property, value)
      }
      page.release()
      onHeightChange?.(0)
    }
  }, [ref, open, hostSelector, contentSelector, allowMapSelector, onHeightChange, position])
}
