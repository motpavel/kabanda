import { describe, expect, it, vi } from 'vitest'
import { containSheetScroll } from './sheet-scroll'

/** Use real cancelable Events; only the DOM ancestry and scroll metrics are fake. */
class ScrollElement {
  scrollTop = 0
  scrollHeight = 100
  clientHeight = 100
  selectionStart = 0
  selectionEnd = 0
  constructor(readonly selector: string, readonly parent: ScrollElement | null = null) {}
  contains(target: ScrollElement): boolean {
    return target === this || !!target.parent && this.contains(target.parent)
  }
  closest(selector: string): ScrollElement | null {
    return selector.split(',').some(part => part.trim() === this.selector) ? this : this.parent?.closest(selector) ?? null
  }
}

class TestDocument extends EventTarget {
  activeElement: ScrollElement | null = null
  // Node's EventTarget does not normalize removeEventListener(..., true) like
  // the DOM does. Keep the browser's equivalent boolean/options semantics.
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    super.removeEventListener(type, callback, typeof options === 'boolean' ? { capture: options } : options)
  }
}

function fixture() {
  const doc = new TestDocument()
  const map = new ScrollElement('.rt-map--point-editing')
  const mapCanvas = new ScrollElement('canvas', map)
  const sheet = Object.assign(new ScrollElement('.rt-point-sheet', map), { ownerDocument: doc })
  const header = new ScrollElement('header', sheet)
  const content = new ScrollElement('.rt-point-sheet__body', sheet)
  const input = new ScrollElement('input', content)
  const note = new ScrollElement('textarea', content)
  const background = new ScrollElement('main')
  let editing = true
  let topmost = true
  const addListener = vi.spyOn(doc, 'addEventListener')
  const removeListener = vi.spyOn(doc, 'removeEventListener')
  const release = containSheetScroll(sheet as unknown as HTMLElement, content as unknown as HTMLElement, () => editing, '.rt-map--point-editing', () => topmost)
  const dispatch = (type: string, target: ScrollElement, props: Record<string, unknown> = {}, cancelable = true) => {
    const event = new Event(type, { cancelable })
    Object.defineProperties(event, Object.fromEntries(Object.entries({ target, ...props }).map(([key, value]) => [key, { value }])))
    doc.dispatchEvent(event)
    return event
  }
  const touch = (type: string, target: ScrollElement, y: number, x = 0, count = 1) => dispatch(type, target, {
    touches: Array.from({ length: count }, (_, index) => ({ clientX: x + index * 10, clientY: y })),
  })
  const drag = (target: ScrollElement, delta: number) => {
    touch('touchstart', target, 100)
    return touch('touchmove', target, 100 - delta)
  }
  const wheel = (target: ScrollElement, deltaY: number) => dispatch('wheel', target, { deltaY })
  return { doc, mapCanvas, sheet, header, content, input, note, background, release, addListener, removeListener, dispatch, touch, drag, wheel, setTopmost: (value: boolean) => { topmost = value }, setEditing: (value: boolean) => { editing = value } }
}

describe('point sheet gesture containment', () => {
  it('blocks root scrolling over a form that fits, in either direction', () => {
    const f = fixture()
    for (const delta of [-60, 60]) {
      expect(f.drag(f.input, delta).defaultPrevented).toBe(true)
      expect(f.wheel(f.note, delta).defaultPrevented).toBe(true)
    }
    f.release()
  })

  it('allows scroll inside an overflowing form and blocks each outward edge', () => {
    const f = fixture()
    f.content.scrollHeight = 400
    f.content.clientHeight = 200
    expect(f.drag(f.input, 50).defaultPrevented).toBe(false)
    expect(f.drag(f.input, -50).defaultPrevented).toBe(true)
    f.content.scrollTop = 100
    expect(f.drag(f.input, 50).defaultPrevented).toBe(false)
    expect(f.wheel(f.input, -50).defaultPrevented).toBe(false)
    f.content.scrollTop = 200
    expect(f.drag(f.note, 50).defaultPrevented).toBe(true)
    expect(f.wheel(f.note, 50).defaultPrevented).toBe(true)
    expect(f.drag(f.note, -50).defaultPrevented).toBe(false)
    f.release()
  })

  it('updates direction during a continuous gesture without waiting for touchend', () => {
    const f = fixture()
    f.content.scrollHeight = 400
    f.content.scrollTop = 300
    f.touch('touchstart', f.input, 100)
    expect(f.touch('touchmove', f.input, 70).defaultPrevented).toBe(true)
    expect(f.touch('touchmove', f.input, 80).defaultPrevented).toBe(false)
    f.release()
  })

  it('lets a long note scroll before falling back to the form body', () => {
    const f = fixture()
    f.note.scrollHeight = 300
    f.note.scrollTop = 100
    expect(f.drag(f.note, 40).defaultPrevented).toBe(false)
    expect(f.wheel(f.note, -40).defaultPrevented).toBe(false)
    f.note.scrollTop = 200
    expect(f.drag(f.note, 40).defaultPrevented).toBe(true)
    f.content.scrollHeight = 300
    expect(f.drag(f.note, 40).defaultPrevented).toBe(false)
    f.content.scrollTop = 200
    expect(f.drag(f.note, 40).defaultPrevented).toBe(true)
    f.release()
  })

  it('does not mistake overflow in unrelated elements for available form scroll', () => {
    const f = fixture()
    f.content.scrollHeight = 500
    f.mapCanvas.scrollHeight = 900
    for (const target of [f.header, f.background, f.mapCanvas]) {
      expect(f.drag(target, 40).defaultPrevented).toBe(true)
      expect(f.wheel(target, -40).defaultPrevented).toBe(true)
    }
    f.release()
  })

  it('contains events with an unexpected document target without throwing', () => {
    const f = fixture()
    const target = f.doc as unknown as ScrollElement
    expect(f.drag(target, 40).defaultPrevented).toBe(true)
    expect(f.wheel(target, 40).defaultPrevented).toBe(true)
    f.release()
  })

  it('keeps map pan and pinch available while idle, then blocks them while editing', () => {
    const f = fixture()
    f.setEditing(false)
    expect(f.drag(f.mapCanvas, 80).defaultPrevented).toBe(false)
    expect(f.wheel(f.mapCanvas, 80).defaultPrevented).toBe(false)
    expect(f.touch('touchmove', f.mapCanvas, 50, 0, 2).defaultPrevented).toBe(false)
    f.setEditing(true)
    expect(f.drag(f.mapCanvas, 80).defaultPrevented).toBe(true)
    expect(f.wheel(f.mapCanvas, 80).defaultPrevented).toBe(true)
    expect(f.touch('touchmove', f.mapCanvas, 50, 0, 2).defaultPrevented).toBe(true)
    f.release()
  })

  it('still contains the sheet header when the sheet is nested in the map', () => {
    const f = fixture()
    f.setEditing(false)
    expect(f.drag(f.header, 50).defaultPrevented).toBe(true)
    expect(f.wheel(f.header, 50).defaultPrevented).toBe(true)
    f.release()
  })

  it('preserves horizontal caret gestures only in the focused input', () => {
    const f = fixture()
    f.doc.activeElement = f.note
    f.touch('touchstart', f.note, 100, 100)
    expect(f.touch('touchmove', f.note, 102, 145).defaultPrevented).toBe(false)
    f.touch('touchstart', f.input, 100, 100)
    expect(f.touch('touchmove', f.input, 102, 145).defaultPrevented).toBe(true)
    f.release()
  })

  it('does not let a selected range bypass vertical scroll containment', () => {
    const f = fixture()
    f.doc.activeElement = f.note
    f.note.selectionEnd = 12
    expect(f.drag(f.note, 80).defaultPrevented).toBe(true)
    f.note.scrollHeight = 300
    expect(f.drag(f.note, 80).defaultPrevented).toBe(false)
    f.release()
  })

  it.each(['touchend', 'touchcancel'])('clears the previous gesture after %s', type => {
    const f = fixture()
    f.content.scrollHeight = 400
    f.content.scrollTop = 50
    f.touch('touchstart', f.note, 100)
    f.dispatch(type, f.note, { touches: [] })
    // A stray move must not inherit a usable delta from the finished gesture.
    expect(f.touch('touchmove', f.note, 90).defaultPrevented).toBe(true)
    f.release()
  })

  it('uses cancelable capture listeners and removes all handlers on release', () => {
    const f = fixture()
    for (const type of ['touchmove', 'wheel']) {
      expect(f.addListener).toHaveBeenCalledWith(type, expect.any(Function), { capture: true, passive: false })
    }
    expect(f.drag(f.background, 40).defaultPrevented).toBe(true)
    f.release()
    expect(f.removeListener).toHaveBeenCalledTimes(5)
    for (const [type, handler] of f.addListener.mock.calls) {
      expect(f.removeListener).toHaveBeenCalledWith(type, handler, true)
    }
    expect(f.drag(f.background, 40).defaultPrevented).toBe(false)
    expect(f.wheel(f.background, 40).defaultPrevented).toBe(false)
  })
})


it('lets the top sheet own gestures while a lower sheet stays mounted', () => {
  const f = fixture()
  f.setTopmost(false)
  expect(f.drag(f.note, 80).defaultPrevented).toBe(false)
  expect(f.wheel(f.background, 80).defaultPrevented).toBe(false)
  f.setTopmost(true)
  expect(f.drag(f.note, 80).defaultPrevented).toBe(true)
  f.release()
})
