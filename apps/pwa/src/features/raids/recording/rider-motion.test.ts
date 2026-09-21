import { describe, expect, it } from 'vitest'
import { RiderMotion, RIDER_MOTION_MAX_MS, type MotionCoordinate, type MotionTarget } from './rider-motion'

function fixture() {
  let now = 0, sequence = 0
  const callbacks = new Map<number, (time: number) => void>()
  const frames: Array<Map<string, MotionCoordinate>> = []
  const motion = new RiderMotion(points => frames.push(new Map(points)), {
    now: () => now,
    request: callback => { callbacks.set(++sequence, callback); return sequence },
    cancel: handle => { callbacks.delete(handle) },
  })
  return { motion, callbacks, frames,
    tick: (time: number, frameTime = time) => { now = time; const current = [...callbacks.values()]; callbacks.clear(); current.forEach(callback => callback(frameTime)) },
    advance: (time: number) => { now = time },
    coordinate: (id = 'viewer') => frames.at(-1)?.get(id),
  }
}
const target = (meters: number, observedAt = 1000, extra: Partial<MotionTarget> = {}): MotionTarget => ({
  id: 'viewer', anchorId: 'rider', members: ['rider'], coordinate: [56 + meters / 111195, 53], observedAt, stale: false, ...extra,
})
const meters = (point: MotionCoordinate | undefined) => (point![0] - 56) * 111195

describe('rider presentation interpolation', () => {
  it('places the first position immediately without an idle RAF loop', () => {
    const f = fixture(); f.motion.update([target(0)])
    expect(f.coordinate()).toEqual(target(0).coordinate)
    expect(f.callbacks.size).toBe(0)
  })
  it('moves through intermediate positions and stops exactly at the received endpoint', () => {
    const f = fixture(); f.motion.update([target(0)]); f.motion.update([target(20, 3000)])
    expect(meters(f.coordinate())).toBeCloseTo(0)
    f.tick(500); expect(meters(f.coordinate())).toBeCloseTo(5)
    f.tick(1000); expect(meters(f.coordinate())).toBeCloseTo(10)
    f.tick(2000); expect(f.coordinate()).toEqual(target(20, 3000).coordinate)
    expect(f.callbacks.size).toBe(0)
    f.tick(30_000); expect(meters(f.coordinate())).toBeCloseTo(20)
  })
  it('does not rewind when a RAF timestamp precedes a paint within the same frame', () => {
    const f = fixture(); f.motion.update([target(0)]); f.motion.update([target(20, 3000)])
    f.advance(1010); f.motion.update([target(20, 3000)])
    const before = meters(f.coordinate())
    f.tick(1012, 1000)
    expect(meters(f.coordinate())).toBeGreaterThanOrEqual(before)
    expect(meters(f.coordinate())).toBeCloseTo(10.12)
    f.tick(2001, 1990)
    expect(f.coordinate()).toEqual(target(20, 3000).coordinate)
    expect(f.callbacks.size).toBe(0)
  })
  it('retargets from the currently displayed position with no rewind or overshoot', () => {
    const f = fixture(); f.motion.update([target(0)]); f.motion.update([target(20, 3000)])
    f.tick(1000); f.motion.update([target(30, 4000)])
    expect(meters(f.coordinate())).toBeCloseTo(10)
    expect(f.callbacks.size).toBe(1)
    f.tick(1500); expect(meters(f.coordinate())).toBeCloseTo(20)
    f.tick(2000); expect(meters(f.coordinate())).toBeCloseTo(30)
    expect(f.callbacks.size).toBe(0)
  })
  it('does not restart on duplicate polls or stationary timestamp refreshes', () => {
    const f = fixture(); f.motion.update([target(0)]); f.motion.update([target(20, 3000)])
    f.tick(500); f.motion.update([target(20, 3000)])
    f.tick(1000); f.motion.update([target(20, 4000)])
    f.tick(2000); expect(meters(f.coordinate())).toBeCloseTo(20)
    expect(f.callbacks.size).toBe(0)
  })
  it('does not rewind on an older or conflicting same-time fix', () => {
    const f = fixture(); f.motion.update([target(0)]); f.motion.update([target(20, 3000)])
    f.tick(1000); f.motion.update([target(-20, 2000)])
    f.motion.update([target(-50, 3000)])
    f.tick(2000); expect(meters(f.coordinate())).toBeCloseTo(20)
  })
  it.each([60, 120])('uses elapsed time rather than frame count at %s Hz', hz => {
    const f = fixture(); f.motion.update([target(0)]); f.motion.update([target(20, 3000)])
    for (let index = 1; index <= hz; index++) f.tick(index * 1000 / hz)
    expect(meters(f.coordinate())).toBeCloseTo(10)
  })
  it('caps smoothing at two seconds and does not extrapolate through a missing fix', () => {
    const f = fixture(); f.motion.update([target(0)]); f.motion.update([target(40, 6000)])
    f.tick(RIDER_MOTION_MAX_MS); expect(meters(f.coordinate())).toBeCloseTo(40)
    expect(f.callbacks.size).toBe(0)
  })
  it('places a long-gap or large correction directly rather than flying across the map', () => {
    const f = fixture(); f.motion.update([target(0)]); f.motion.update([target(500, 3000)])
    expect(meters(f.coordinate())).toBeCloseTo(500); expect(f.callbacks.size).toBe(0)
    f.motion.update([target(510, 20_000)])
    expect(meters(f.coordinate())).toBeCloseTo(510); expect(f.callbacks.size).toBe(0)
  })
  it('does not animate stale fixes or movement after stale recovery', () => {
    const f = fixture(); f.motion.update([target(0)]); f.motion.update([target(20, 3000, { stale: true })])
    expect(meters(f.coordinate())).toBeCloseTo(20); expect(f.callbacks.size).toBe(0)
    f.motion.update([target(30, 4000)])
    expect(meters(f.coordinate())).toBeCloseTo(30); expect(f.callbacks.size).toBe(0)
  })
  it('suspends hidden/reduced-motion maps and never replays their missed travel', () => {
    const f = fixture(); f.motion.update([target(0)]); f.motion.update([target(20, 3000)])
    f.tick(500); const late = [...f.callbacks.values()][0]!
    f.motion.setEnabled(false)
    expect(meters(f.coordinate())).toBeCloseTo(20); expect(f.callbacks.size).toBe(0)
    f.motion.update([target(30, 4000)])
    expect(meters(f.coordinate())).toBeCloseTo(30); expect(f.callbacks.size).toBe(0)
    f.motion.setEnabled(true); late(1000)
    expect(meters(f.coordinate())).toBeCloseTo(30); expect(f.callbacks.size).toBe(0)
  })
  it('retains visible continuity when a viewer joins a flock and splits again', () => {
    const f = fixture(); f.motion.update([target(0)]); f.motion.update([target(20, 3000)])
    f.tick(1000)
    f.motion.update([target(25, 4000, { id: 'flock', members: ['rider', 'other'] })])
    expect(f.coordinate()).toBeUndefined()
    expect(meters(f.coordinate('flock'))).toBeCloseTo(10)
    f.tick(1500)
    f.motion.update([target(30, 5000), target(40, 5000, { id: 'other', anchorId: 'other', members: ['other'] })])
    expect(meters(f.coordinate())).toBeCloseTo(17.5)
    expect(meters(f.coordinate('other'))).toBeCloseTo(17.5)
    expect(f.coordinate('flock')).toBeUndefined()
  })
  it('uses one RAF for all moving markers and drops removed riders immediately', () => {
    const f = fixture()
    f.motion.update([target(0), target(10, 1000, { id: 'other', anchorId: 'other', members: ['other'] })])
    f.motion.update([target(20, 3000), target(30, 3000, { id: 'other', anchorId: 'other', members: ['other'] })])
    expect(f.callbacks.size).toBe(1)
    f.tick(1000); f.motion.update([target(20, 3000)])
    expect(f.coordinate('other')).toBeUndefined()
    f.motion.update([]); expect(f.callbacks.size).toBe(0)
  })
  it('cancels stale callbacks on map/identity/raid reset and starts the next context cleanly', () => {
    const f = fixture(); f.motion.update([target(0)]); f.motion.update([target(20, 3000)])
    const late = [...f.callbacks.values()][0]!
    f.motion.reset(); f.motion.update([target(200)])
    late(1000)
    expect(meters(f.coordinate())).toBeCloseTo(200); expect(f.callbacks.size).toBe(0)
  })
  it('copies inputs and rejects invalid coordinates without mutating evidence', () => {
    const f = fixture(), input = target(0), original = structuredClone(input)
    f.motion.update([input]); f.motion.update([target(20, 3000)]); f.tick(1000)
    expect(input).toEqual(original)
    f.motion.update([target(20, Number.NaN), target(20, 5000, { coordinate: [100, 53] })])
    expect(f.callbacks.size).toBe(0)
  })
})
