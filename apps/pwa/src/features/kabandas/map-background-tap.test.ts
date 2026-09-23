import { describe, expect, it } from 'vitest'
import { isMapMarkerHit, MapBackgroundTap } from './map-background-tap'

const pointer = { pointerId: 1, clientX: 100, clientY: 150, timeStamp: 100, button: 0, isPrimary: true }

describe('free map sheet background dismissal', () => {
  it('accepts a short one-finger tap with natural finger drift', () => {
    const tap = new MapBackgroundTap()
    tap.down(pointer)
    expect(tap.up({ ...pointer, clientX: 106, timeStamp: 400 })).toBe(true)
    expect(tap.up({ ...pointer, timeStamp: 450 })).toBe(false)
  })

  it('does not dismiss after a pan, including returning to its starting point', () => {
    const tap = new MapBackgroundTap()
    tap.down(pointer)
    tap.move({ ...pointer, clientY: 170, timeStamp: 120 })
    tap.move({ ...pointer, timeStamp: 140 })
    expect(tap.up({ ...pointer, timeStamp: 200 })).toBe(false)
    tap.down(pointer)
    expect(tap.up({ ...pointer, clientX: 130, timeStamp: 200 })).toBe(false)
  })

  it('cancels a pinch even when the first finger did not move', () => {
    const tap = new MapBackgroundTap()
    tap.down(pointer)
    tap.down({ ...pointer, pointerId: 2, isPrimary: false, timeStamp: 150 })
    expect(tap.up({ ...pointer, timeStamp: 200 })).toBe(false)
    expect(tap.up({ ...pointer, pointerId: 2, timeStamp: 220 })).toBe(false)
  })

  it('rejects long presses, non-primary mouse buttons and cancelled gestures', () => {
    const tap = new MapBackgroundTap()
    tap.down(pointer)
    expect(tap.up({ ...pointer, timeStamp: 601 })).toBe(false)
    tap.down({ ...pointer, button: 2 })
    expect(tap.up({ ...pointer, timeStamp: 200 })).toBe(false)
    tap.down(pointer)
    tap.cancel()
    expect(tap.up({ ...pointer, timeStamp: 200 })).toBe(false)
  })

  it('preserves taps on markers even when the SDK event pane hides their DOM target', () => {
    const markers = [{ left: 90, top: 140, width: 20, height: 20 }]
    expect(isMapMarkerHit(100, 150, markers)).toBe(true)
    expect(isMapMarkerHit(121, 150, markers)).toBe(true)
    expect(isMapMarkerHit(140, 150, markers)).toBe(false)
    expect(isMapMarkerHit(0, 0, [{ left: 0, top: 0, width: 0, height: 0 }])).toBe(false)
  })
})
