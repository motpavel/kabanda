import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePointSheetViewport } from './usePointSheetViewport'

const effects = vi.hoisted(() => ({ mount: null as (() => void | (() => void)) | null }))
vi.mock('react', () => ({ useLayoutEffect: (mount: () => void | (() => void)) => { effects.mount = mount } }))

function style() {
  const values = new Map<string, string>()
  const key = (name: string) => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
  const methods = {
    getPropertyValue: (name: string) => values.get(name) ?? '',
    setProperty: (name: string, value: string) => { values.set(name, value) },
    removeProperty: (name: string) => { const value = values.get(name) ?? ''; values.delete(name); return value },
  }
  return new Proxy(methods, {
    get: (target, name: string) => name in target ? target[name as keyof typeof methods] : values.get(key(name)) ?? '',
    set: (_target, name: string, value: string) => { values.set(key(name), value); return true },
  }) as unknown as CSSStyleDeclaration
}

class DOMTarget extends EventTarget {
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    super.removeEventListener(type, callback, typeof options === 'boolean' ? { capture: options } : options)
  }
}

class TestElement extends DOMTarget {
  style = style()
  dataset: Record<string, string> = {}
  children: TestElement[] = []
  clientHeight = 100
  clientWidth = 390
  scrollHeight = 100
  scrollTop = 0
  top = 0
  height = 100
  ownerDocument!: TestDocument
  focus = vi.fn((_options?: FocusOptions) => { this.ownerDocument.activeElement = this })
  constructor(readonly selector: string, readonly parent: TestElement | null = null) {
    super()
    parent?.children.push(this)
  }
  contains(target: unknown): boolean {
    return target === this || target instanceof TestElement && !!target.parent && this.contains(target.parent)
  }
  matches(selectors: string) { return selectors.split(',').some(selector => selector.trim() === this.selector) }
  closest(selectors: string): TestElement | null { return this.matches(selectors) ? this : this.parent?.closest(selectors) ?? null }
  querySelector(selector: string): TestElement | null {
    for (const child of this.children) {
      const match = child.matches(selector) ? child : child.querySelector(selector)
      if (match) return match
    }
    return null
  }
  getBoundingClientRect() { return { top: this.top, bottom: this.top + this.height, height: this.height } as DOMRect }
}

class TestDocument extends DOMTarget {
  body = new TestElement('body')
  documentElement = new TestElement('html')
  activeElement: TestElement | null = null
}

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals() })

function mount() {
  const doc = new TestDocument()
  const shell = new TestElement('.rt-editor-shell')
  const sheet = new TestElement('.rt-point-sheet', shell)
  const content = new TestElement('.rt-point-sheet__body', sheet)
  const note = new TestElement('textarea', content)
  for (const element of [shell, sheet, content, note]) element.ownerDocument = doc
  doc.documentElement.clientHeight = 844
  doc.body.style.position = 'relative'
  doc.body.style.top = '7px'
  doc.body.style.overscrollBehavior = 'contain'
  doc.documentElement.style.overflow = 'clip'
  doc.documentElement.style.scrollBehavior = 'smooth'
  sheet.height = 330
  const viewport = Object.assign(new DOMTarget(), { height: 844, offsetTop: 0, scale: 1 })
  const win = Object.assign(new DOMTarget(), { innerHeight: 844, scrollX: 18, scrollY: 70, visualViewport: viewport, scrollTo: vi.fn() })
  win.scrollTo.mockImplementation(({ left, top }: ScrollToOptions) => { win.scrollX = left ?? 0; win.scrollY = top ?? 0 })
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const observer = { observe: vi.fn(), disconnect: vi.fn() }
  vi.stubGlobal('HTMLElement', TestElement)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', win)
  vi.stubGlobal('navigator', { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 })
  vi.stubGlobal('ResizeObserver', class { constructor() { return observer } })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const heightChange = vi.fn()
  usePointSheetViewport({ current: sheet as unknown as HTMLElement }, heightChange)
  const cleanup = effects.mount?.()
  if (typeof cleanup !== 'function') throw new Error('Expected mounted viewport hook')
  let active = true
  const release = () => { if (active) { active = false; cleanup() } }
  cleanups.push(release)
  const flush = () => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback(0))
  }
  const dispatch = (type: string, target: TestElement, props: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true })
    Object.defineProperties(event, Object.fromEntries(Object.entries({ target, ...props }).map(([key, value]) => [key, { value }])))
    sheet.dispatchEvent(event)
    return event
  }
  const focus = () => { doc.activeElement = note; dispatch('focusin', note) }
  return { doc, shell, sheet, content, note, viewport, win, observer, frames, heightChange, release, flush, dispatch, focus }
}

describe('point sheet viewport lifecycle', () => {
  it('keeps its original height baseline through keyboard animation and clears keyboard state on dismissal', () => {
    const f = mount()
    f.focus()
    f.win.innerHeight = 430
    f.doc.documentElement.clientHeight = 430
    Object.assign(f.viewport, { height: 430, offsetTop: 220 })
    f.viewport.dispatchEvent(new Event('resize'))
    expect(f.shell.dataset.pointSheetKeyboard).toBe('true')
    expect(f.shell.style.getPropertyValue('--rt-viewport-top')).toBe('220px')
    expect(f.shell.style.getPropertyValue('--rt-viewport-height')).toBe('430px')
    expect(f.shell.style.getPropertyValue('--rt-sheet-expanded-height')).toBe('418px')
    f.win.innerHeight = 844
    f.doc.documentElement.clientHeight = 844
    Object.assign(f.viewport, { height: 844, offsetTop: 90 })
    f.viewport.dispatchEvent(new Event('resize'))
    expect(f.shell.dataset.pointSheetKeyboard).toBe('false')
    expect(f.shell.style.getPropertyValue('--rt-viewport-top')).toBe('0px')
  })

  it('reveals the focused field on keyboard resize, without fighting internal scroll on viewport pan', () => {
    const f = mount()
    f.content.top = 200
    f.content.height = 100
    f.note.top = 285
    f.note.height = 46
    f.focus()
    f.flush()
    f.flush()
    expect(f.content.scrollTop).toBeGreaterThan(0)
    f.content.scrollTop = 64
    f.viewport.offsetTop = 30
    f.viewport.dispatchEvent(new Event('scroll'))
    f.flush()
    expect(f.content.scrollTop).toBe(64)
  })

  it('replaces the height baseline on rotation while the text field keeps focus', () => {
    const f = mount()
    f.focus()
    Object.assign(f.viewport, { height: 430, offsetTop: 0 })
    f.viewport.dispatchEvent(new Event('resize'))
    expect(f.shell.dataset.pointSheetKeyboard).toBe('true')
    f.doc.documentElement.clientWidth = 844
    f.doc.documentElement.clientHeight = 390
    f.win.innerHeight = 390
    f.viewport.height = 180
    f.win.dispatchEvent(new Event('resize'))
    expect(f.shell.dataset.pointSheetKeyboard).toBe('true')
    Object.assign(f.viewport, { height: 390, offsetTop: 20 })
    f.viewport.dispatchEvent(new Event('resize'))
    expect(f.shell.dataset.pointSheetKeyboard).toBe('false')
    expect(f.shell.style.getPropertyValue('--rt-viewport-top')).toBe('0px')
  })

  it('focuses a tapped iPhone field without native root pan and restores its appearance next frame', () => {
    const f = mount()
    f.note.style.opacity = '.8'
    f.dispatch('touchstart', f.note, { touches: [{ clientX: 20, clientY: 30 }] })
    const end = f.dispatch('touchend', f.note, { touches: [] })
    expect(end.defaultPrevented).toBe(true)
    expect(f.note.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(f.note.style.opacity).toBe('0')
    f.flush()
    expect(f.note.style.opacity).toBe('.8')
    expect(f.shell.dataset.pointSheetEditing).toBe('true')
  })

  it('does not focus a field at the end of a scrolling gesture', () => {
    const f = mount()
    f.dispatch('touchstart', f.note, { touches: [{ clientX: 20, clientY: 30 }] })
    f.dispatch('touchmove', f.note, { touches: [{ clientX: 20, clientY: 80 }] })
    expect(f.dispatch('touchend', f.note, { touches: [] }).defaultPrevented).toBe(false)
    expect(f.note.focus).not.toHaveBeenCalled()
  })

  it('resets unexpected root scroll and completely restores the page on unmount', () => {
    const f = mount()
    expect(f.doc.body.style.position).toBe('fixed')
    expect(f.doc.body.style.top).toBe('-70px')
    f.focus()
    expect(f.note.style.opacity).toBe('0')
    f.win.scrollY = 64
    f.win.dispatchEvent(new Event('scroll'))
    expect(f.win.scrollY).toBe(0)
    f.release()
    expect(f.doc.body.style.position).toBe('relative')
    expect(f.doc.body.style.top).toBe('7px')
    expect(f.doc.body.style.overscrollBehavior).toBe('contain')
    expect(f.doc.documentElement.style.overflow).toBe('clip')
    expect(f.doc.documentElement.style.scrollBehavior).toBe('smooth')
    expect(f.note.style.opacity).toBe('')
    expect(f.win.scrollX).toBe(18)
    expect(f.win.scrollY).toBe(70)
    expect(f.observer.disconnect).toHaveBeenCalledOnce()
    expect(f.frames.size).toBe(0)
    expect(f.shell.dataset).toEqual({})
    expect(f.shell.style.getPropertyValue('--rt-viewport-height')).toBe('')
    expect(f.heightChange).toHaveBeenLastCalledWith(0)
    f.heightChange.mockClear()
    f.viewport.dispatchEvent(new Event('resize'))
    f.win.dispatchEvent(new Event('scroll'))
    f.dispatch('focusin', f.note)
    expect(f.heightChange).not.toHaveBeenCalled()
    expect(f.win.scrollY).toBe(70)
  })
})
