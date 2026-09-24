// Several mounted sheets may overlap briefly while one closes and another opens.
// Only the last release may restore the page; only the top sheet owns gestures.
const owners: HTMLElement[] = []
let restore: (() => void) | null = null

export function lockSheetPage(owner: HTMLElement) {
  if (owners.length === 0) {
    const body = document.body
    const root = document.documentElement
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const bodyKeys = ['position', 'top', 'left', 'right', 'width', 'overflow', 'overscroll-behavior'] as const
    const rootKeys = ['overflow', 'overscroll-behavior', 'scroll-behavior'] as const
    const bodyValues = bodyKeys.map(key => [key, body.style.getPropertyValue(key)] as const)
    const rootValues = rootKeys.map(key => [key, root.style.getPropertyValue(key)] as const)
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
    restore = () => {
      for (const [key, value] of bodyValues) body.style.setProperty(key, value)
      for (const [key, value] of rootValues) root.style.setProperty(key, value)
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' })
    }
  }
  owners.push(owner)
  let active = true
  return {
    isTopmost: () => active && owners.at(-1) === owner,
    release: () => {
      if (!active) return
      active = false
      owners.splice(owners.indexOf(owner), 1)
      if (owners.length === 0) { restore?.(); restore = null }
    },
  }
}
