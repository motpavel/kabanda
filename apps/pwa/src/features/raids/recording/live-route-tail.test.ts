import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { LiveRouteTail, LIVE_TAIL_MAX_VERTICES, navigatorMotionMarker, type TailCoordinate, type TailFix, type TailFrame } from './live-route-tail'
import { LiveRouteLayers } from './live-route-layers'

const coordinate = (north: number, east = 0): TailCoordinate => [56 + north / 111195, 53 + east / 60000]
const fix = (north: number, observedAt: number, east = 0): TailFix => ({ coordinate: coordinate(north, east), observedAt })
function fixture() {
  let frame: TailFrame = { history: [], tip: [] }
  let renders = 0
  const tail = new LiveRouteTail(next => { frame = next; renders++ })
  return { tail, frame: () => frame, renders: () => renders,
    update: (point: TailFix, anchor: TailFix | null = null, scope = 'navigator:lease1') => tail.update(scope, point, anchor, point.observedAt) }
}
const end = (value: TailFrame) => value.tip.at(-1)
const close = (actual: TailCoordinate | undefined, expected: TailCoordinate) => {
  assert.ok(actual)
  assert.ok(Math.abs(actual[0] - expected[0]) < 1e-10)
  assert.ok(Math.abs(actual[1] - expected[1]) < 1e-10)
}

describe('live route display only', () => {
  it('draws a fresh local extension before the server route advances', () => {
    const f = fixture()
    f.update(fix(30, 1000), fix(0, 0)); f.tail.paint(coordinate(30))
    close(f.frame().tip[0], coordinate(0)); close(end(f.frame()), coordinate(30))
  })
  it('shares each rendered endpoint with the icon and never rebuilds history per frame', () => {
    const f = fixture()
    f.update(fix(60, 2000), fix(0, 0))
    const history = f.frame().history
    for (let i = 1; i <= 120; i++) {
      f.tail.paint(coordinate(i / 2))
      assert.equal(f.frame().tip.length, 2)
      assert.equal(f.frame().history, history)
      close(end(f.frame()), coordinate(i / 2))
    }
  })
  it('does not draw backwards from an unvisited initial target without a safe anchor', () => {
    const f = fixture()
    f.update(fix(30, 1000)); f.tail.paint(coordinate(0)); f.tail.paint(coordinate(15))
    assert.equal(f.frame().tip.length, 0)
    f.tail.paint(coordinate(30)); f.update(fix(60, 2000)); f.tail.paint(coordinate(45))
    close(f.frame().tip[0], coordinate(30)); close(end(f.frame()), coordinate(45))
  })
  it('freezes the displayed point rather than an unreached GPS target on retarget', () => {
    const f = fixture()
    f.update(fix(20, 1000), fix(0, 0)); f.tail.paint(coordinate(10))
    f.update(fix(40, 2000)); f.tail.paint(coordinate(11))
    assert.deepEqual(f.frame().history, [[coordinate(0), coordinate(10)]])
    close(f.frame().tip[0], coordinate(10)); close(end(f.frame()), coordinate(11))
  })
  it('keeps turns instead of replacing the whole unsynchronised suffix by one chord', () => {
    const f = fixture()
    f.update(fix(20, 1000), fix(0, 0)); f.tail.paint(coordinate(20))
    f.update(fix(20, 2000, 20)); f.tail.paint(coordinate(20, 20))
    f.update(fix(40, 3000, 20)); f.tail.paint(coordinate(30, 20))
    assert.deepEqual(f.frame().history, [[coordinate(0), coordinate(20), coordinate(20, 20)]])
    close(end(f.frame()), coordinate(30, 20))
  })
  it('retires a matching confirmed prefix, preserving the unconfirmed turn', () => {
    const f = fixture()
    f.update(fix(20, 1000), fix(0, 0)); f.tail.paint(coordinate(20))
    f.update(fix(20, 2000, 20)); f.tail.paint(coordinate(20, 20))
    f.update(fix(40, 3000, 20)); f.tail.paint(coordinate(30, 20))
    f.update(fix(40, 3000, 20), fix(20, 1000))
    assert.deepEqual(f.frame().history, [[coordinate(20), coordinate(20, 20)]])
    close(end(f.frame()), coordinate(30, 20))
  })
  it('does not discard a moving preview just because the server reached the raw target', () => {
    const f = fixture()
    f.update(fix(60, 2000), fix(0, 0)); f.tail.paint(coordinate(30))
    f.update(fix(60, 2000), fix(60, 2000))
    close(end(f.frame()), coordinate(30))
    f.tail.paint(coordinate(60))
    assert.deepEqual(f.frame().history, []); assert.deepEqual(f.frame().tip, [])
  })
  it('retires a settled preview on a server-only refresh without requiring another GPS event', () => {
    const f = fixture()
    f.update(fix(60, 2000), fix(0, 0)); f.tail.paint(coordinate(60))
    f.update(fix(60, 2000), fix(60, 2000))
    assert.equal(f.frame().tip.length, 0); assert.equal(f.frame().history.length, 0)
  })
  it('keeps the tail when a stationary-filtered endpoint has caught up only in timestamp', () => {
    const f = fixture()
    f.update(fix(30, 2000), fix(0, 0)); f.tail.paint(coordinate(30))
    f.update(fix(30, 2000), fix(0, 2000)); f.tail.paint(coordinate(30))
    close(end(f.frame()), coordinate(30))
    f.update(fix(30, 2000), fix(0, 3000)); f.tail.paint(coordinate(30))
    close(end(f.frame()), coordinate(30))
    f.update(fix(30, 2000), fix(30, 3001))
    assert.equal(f.frame().tip.length, 0)
  })
  it('does not resurrect a retired prefix from a delayed older route page', () => {
    const f = fixture()
    f.update(fix(60, 2000), fix(0, 0)); f.tail.paint(coordinate(60))
    f.update(fix(60, 2000), fix(60, 2000))
    f.update(fix(60, 2000), fix(0, 0)); f.tail.paint(coordinate(60))
    assert.equal(f.frame().tip.length, 0); assert.equal(f.frame().history.length, 0)
  })
  it('ignores reordered GPS and conflicting same-timestamp fixes', () => {
    const f = fixture()
    f.update(fix(60, 2000), fix(0, 0)); f.tail.paint(coordinate(30))
    const before = f.frame()
    f.update(fix(10, 1000)); f.update(fix(0, 2000))
    assert.equal(f.frame(), before)
  })
  it('does not accumulate vertices on repeated stationary fixes', () => {
    const f = fixture()
    f.update(fix(60, 2000), fix(0, 0)); f.tail.paint(coordinate(30))
    const history = f.frame().history
    for (let n = 0; n < 100; n++) f.update(fix(60, 2000 + n))
    assert.equal(f.frame().history, history)
    f.tail.paint(coordinate(60)); close(end(f.frame()), coordinate(60))
  })
  it('does not connect across a GPS time gap', () => {
    const f = fixture()
    f.update(fix(0, 0)); f.tail.paint(coordinate(0))
    f.update(fix(40, 11000)); f.tail.paint(coordinate(40))
    assert.equal(f.frame().tip.length, 0); assert.equal(f.frame().history.length, 0)
    f.update(fix(60, 12000)); f.tail.paint(coordinate(50))
    close(f.frame().tip[0], coordinate(40)); close(end(f.frame()), coordinate(50))
  })
  it('does not connect a large correction, then resumes from the corrected position', () => {
    const f = fixture()
    f.update(fix(0, 0)); f.tail.paint(coordinate(0))
    f.update(fix(300, 1000)); f.tail.paint(coordinate(300))
    assert.equal(f.frame().tip.length, 0)
    f.update(fix(330, 2000)); f.tail.paint(coordinate(315))
    close(f.frame().tip[0], coordinate(300)); close(end(f.frame()), coordinate(315))
  })
  it('drops an invalid, stale or implausibly future source without publishing it', () => {
    const f = fixture(), before = f.renders()
    for (const invalid of [{ coordinate: [NaN, 0] as const, observedAt: 1 }, { coordinate: [100, 0] as const, observedAt: 1 }, fix(0, NaN)]) f.update(invalid)
    f.tail.update('lease', fix(20, 0), null, 11000)
    f.tail.update('lease', fix(20, 10000), null, 0)
    assert.equal(f.renders(), before)
  })
  it('keeps route bytes independent of frozen input objects', () => {
    const f = fixture()
    const source = Object.freeze({ coordinate: Object.freeze([56, 53] as const), observedAt: 1000 })
    const anchor = Object.freeze({ coordinate: Object.freeze([55.9999, 53] as const), observedAt: 0 })
    const before = JSON.stringify([source, anchor])
    f.update(source, anchor); f.tail.paint(coordinate(0))
    assert.equal(JSON.stringify([source, anchor]), before)
  })
  it('clears an account/navigator/lease change without borrowing the previous track anchor', () => {
    const f = fixture()
    f.update(fix(60, 2000), fix(0, 0)); f.tail.paint(coordinate(60))
    f.update(fix(80, 3000), fix(60, 2000), 'other-navigator:lease2'); f.tail.paint(coordinate(80))
    assert.equal(f.frame().tip.length, 0); assert.equal(f.frame().history.length, 0)
  })
  it('does not bridge a hidden, paused or access-denied interval, including replay of an old fix', () => {
    const f = fixture()
    f.update(fix(60, 2000), fix(0, 0)); f.tail.paint(coordinate(30))
    f.tail.interrupt(2500)
    f.update(fix(60, 2000)); f.tail.paint(coordinate(60))
    assert.equal(f.frame().tip.length, 0)
    f.update(fix(80, 3000), fix(60, 2000)); f.tail.paint(coordinate(80))
    assert.equal(f.frame().tip.length, 0)
    f.update(fix(100, 4000)); f.tail.paint(coordinate(90))
    close(f.frame().tip[0], coordinate(80)); close(end(f.frame()), coordinate(90))
  })
  it('bounds memory during prolonged loss of route synchronisation', () => {
    const f = fixture()
    for (let n = 0; n < 2000; n++) {
      f.update(fix(n, n * 1000)); f.tail.paint(coordinate(n))
      assert.ok(f.frame().history.flat().length <= LIVE_TAIL_MAX_VERTICES)
      assert.ok(f.frame().tip.length <= 2)
    }
    close(end(f.frame()), coordinate(1999))
  })
  it('paints a reduced-motion endpoint directly with no required animation loop', () => {
    const f = fixture()
    f.update(fix(60, 2000), fix(0, 0)); f.tail.paint(coordinate(60))
    close(end(f.frame()), coordinate(60))
    const calls = f.renders()
    f.tail.paint(coordinate(60)); assert.equal(f.renders(), calls)
  })
})

describe('navigator ownership', () => {
  const marker = (id: string, members: string[], kind = 'flock', stale = false) => ({ id, members, kind, stale })
  it('selects the local navigator both alone and in a flock', () => {
    for (const candidate of [marker('viewer', ['me'], 'navigator'), marker('flock', ['me', 'other'])])
      assert.equal(navigatorMotionMarker([candidate], 'me', 'me'), candidate)
  })
  it('selects a remote navigator or a flock anchored to that navigator', () => {
    const candidate = marker('flock', ['nav', 'other'])
    assert.equal(navigatorMotionMarker([candidate], 'me', 'nav'), candidate)
  })
  it('never selects the viewer-anchored flock as a route source for another navigator', () => {
    assert.equal(navigatorMotionMarker([marker('flock', ['me', 'nav'])], 'me', 'nav'), null)
  })
  it('excludes stale and participant-only markers and handles legacy local identity', () => {
    assert.equal(navigatorMotionMarker([marker('viewer', ['me'], 'participant'), marker('remote', ['nav'], 'navigator', true)], 'me', 'nav'), null)
    const candidate = marker('viewer', [], 'navigator')
    assert.equal(navigatorMotionMarker([candidate], 'me', 'me'), candidate)
    assert.equal(navigatorMotionMarker([candidate], 'me', null), null)
  })
})

describe('incremental provider boundary', () => {
  function provider() {
    const objects = new Set<object>(), writes: { part: unknown; count: number; end: TailCoordinate | undefined }[] = []
    class Polyline {
      geometry = { setCoordinates: (points: readonly TailCoordinate[]) => {
        writes.push({ part: this.properties.routePreviewPart, count: points.length, end: points.at(-1) })
      } }
      constructor(readonly points: readonly TailCoordinate[], readonly properties: Record<string, unknown> = {}) {}
    }
    const layers = new LiveRouteLayers({ geoObjects: { add: obj => { objects.add(obj) }, remove: obj => { objects.delete(obj) } } }, { Polyline })
    return { layers, objects, writes }
  }
  it('updates only the two-vertex tip for 120 frames; preserves history and map objects', () => {
    const f = provider()
    const history = [[coordinate(0), coordinate(20)]]
    f.layers.update({ history, tip: [coordinate(20), coordinate(21)] })
    const objects = [...f.objects]
    for (let n = 0; n < 120; n++) f.layers.update({ history, tip: [coordinate(20), coordinate(22 + n / 10)] })
    assert.equal(f.writes.length, 240)
    assert.ok(f.writes.every(write => write.part === 'tip' && write.count === 2))
    assert.deepEqual([...f.objects], objects)
  })
  it('does not repaint duplicate snapshots and clears all objects on disposal', () => {
    const f = provider(), frame = { history: [[coordinate(0), coordinate(20)]], tip: [coordinate(20), coordinate(30)] }
    f.layers.update(frame)
    for (let n = 0; n < 10; n++) f.layers.update({ history: frame.history.map(points => [...points]), tip: [...frame.tip] })
    assert.equal(f.writes.length, 0)
    f.layers.clear(); assert.equal(f.objects.size, 0)
  })
})
