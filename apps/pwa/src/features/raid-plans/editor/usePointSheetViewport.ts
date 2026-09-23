import { useLayoutEffect, type RefObject } from 'react'
import { containPointSheetScroll } from './point-sheet-scroll'
import { pointSheetViewport } from './point-sheet-viewport'

/** Anchor the form to the visible viewport and contain iOS keyboard scrolling. */
export function usePointSheetViewport(ref: RefObject<HTMLElement | null>, onHeightChange: (height: number) => void) {
  useLayoutEffect(() => {
    const sheet = ref.current
    const shell = sheet?.closest<HTMLElement>('.rt-editor-shell')
    const content = sheet?.querySelector<HTMLElement>('.rt-point-sheet__body')
    if (!sheet || !shell || !content) return
    const viewport = window.visualViewport
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const body = document.body
    const root = document.documentElement
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    const bodyProperties = ['position', 'top', 'left', 'right', 'width', 'overflow', 'overscroll-behavior'] as const
    const rootProperties = ['overflow', 'overscroll-behavior', 'scroll-behavior'] as const
    const previousBody = bodyProperties.map(property => [property, body.style.getPropertyValue(property)] as const)
    const previousRoot = rootProperties.map(property => [property, root.style.getPropertyValue(property)] as const)
    body.style.position = 'fixed'
    body.style.top = `${-scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'
    body.style.overflow = 'hidden'
    body.style.overscrollBehavior = 'none'
    root.style.overflow = 'hidden'
    root.style.overscrollBehavior = 'none'
    root.style.scrollBehavior = 'auto'
    window.scrollTo({ left: 0, top: 0, behavior: 'instant' })
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
      const geometry = pointSheetViewport(Math.max(layoutHeight, root.clientHeight), viewport)
      const inset = layoutHeight - geometry.height
      keyboardOpen = (editing || keyboardOpen) && inset > 100 && (!viewport || Math.abs(viewport.scale - 1) < .01)
      shell.dataset.pointSheetEditing = String(editing || keyboardOpen)
      shell.dataset.pointSheetKeyboard = String(keyboardOpen)
      shell.style.setProperty('--rt-viewport-top', `${geometry.top}px`)
      shell.style.setProperty('--rt-viewport-height', `${geometry.height}px`)
      shell.style.setProperty('--rt-sheet-max-height', `${geometry.maxSheetHeight}px`)
      shell.style.setProperty('--rt-sheet-expanded-height', `${Math.max(1, geometry.height - 12)}px`)
      onHeightChange(Math.ceil(sheet.getBoundingClientRect().height))
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
    fit()
    const releaseScroll = containPointSheetScroll(sheet, content, () => isEditing() || keyboardOpen)
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
      delete shell.dataset.pointSheetEditing
      delete shell.dataset.pointSheetKeyboard
      for (const property of ['--rt-viewport-top', '--rt-viewport-height', '--rt-sheet-max-height', '--rt-sheet-expanded-height']) shell.style.removeProperty(property)
      for (const [property, value] of previousBody) body.style.setProperty(property, value)
      for (const [property, value] of previousRoot) root.style.setProperty(property, value)
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' })
      onHeightChange(0)
    }
  }, [ref, onHeightChange])
}
