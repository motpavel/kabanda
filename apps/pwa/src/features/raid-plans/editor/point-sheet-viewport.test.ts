import { describe, expect, it } from 'vitest'
import { pointSheetViewport } from './point-sheet-viewport'

describe('point sheet keyboard viewport', () => {
  it('anchors its bottom exactly above an overlay keyboard', () => {
    const geometry = pointSheetViewport(844, { height: 430, offsetTop: 0, scale: 1 })
    expect(geometry).toEqual({ top: 0, height: 430, maxSheetHeight: 418 })
    expect(geometry.top + geometry.height).toBe(430)
  })
  it('follows iOS visual viewport panning without scrolling the document', () => {
    const geometry = pointSheetViewport(844, { height: 370, offsetTop: 90, scale: 1 })
    expect(geometry.top + geometry.height).toBe(460)
    expect(geometry.maxSheetHeight).toBe(358)
  })
  it('uses the available height when Android also resizes the layout viewport', () => {
    expect(pointSheetViewport(350, { height: 350, offsetTop: 0, scale: 1 }).maxSheetHeight).toBe(338)
  })
  it('recovers after keyboard dismissal and does not treat page pinch as a keyboard', () => {
    expect(pointSheetViewport(844, { height: 844, offsetTop: 0, scale: 1 })).toEqual({ top: 0, height: 844, maxSheetHeight: 460 })
    expect(pointSheetViewport(844, { height: 844, offsetTop: 90, scale: 1 })).toEqual(pointSheetViewport(844))
    expect(pointSheetViewport(844, { height: 422, offsetTop: 100, scale: 2 })).toEqual(pointSheetViewport(844))
  })
})
