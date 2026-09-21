/** Display-only positions. Never feed these vertices to the recorder, outbox,
 * distance calculation, check-in eligibility or a persistent route cache. */
export type TailCoordinate = readonly [number, number]
export type TailFix = { coordinate: TailCoordinate; observedAt: number }
type Vertex = TailFix & { breakBefore: boolean }
export type TailFrame = {
  history: readonly (readonly TailCoordinate[])[]
  tip: readonly TailCoordinate[]
}
export const LIVE_TAIL_MAX_VERTICES = 256
const MAX_GAP_MS = 10_000
const MAX_JUMP_M = 250
const EMPTY: readonly TailCoordinate[] = []
const same = (a: TailCoordinate, b: TailCoordinate) => Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10
const valid = (fix: TailFix) => Number.isFinite(fix.observedAt) && fix.coordinate.every(Number.isFinite) &&
  Math.abs(fix.coordinate[0]) <= 90 && Math.abs(fix.coordinate[1]) <= 180
const copy = (fix: TailFix): TailFix => ({ observedAt: fix.observedAt, coordinate: [fix.coordinate[0], fix.coordinate[1]] })
const meters = (a: TailCoordinate, b: TailCoordinate) => {
  const rad = Math.PI / 180
  const longitude = ((b[1] - a[1] + 540) % 360) - 180
  return 6_371_000 * Math.hypot((b[0] - a[0]) * rad, longitude * rad * Math.cos((a[0] + b[0]) * rad / 2))
}
const continuous = (a: TailFix, b: TailFix) => b.observedAt > a.observedAt &&
  b.observedAt - a.observedAt <= MAX_GAP_MS && meters(a.coordinate, b.coordinate) <= MAX_JUMP_M

/** A bounded, temporary extension behind the rendered navigator, not another
 * source of route truth. Inputs arrive at GPS/snapshot cadence. paint() only
 * changes a TWO-vertex tip; it never scans/smooths the full recorded route.
 *
 * On a retarget, freeze the last DISPLAYED position, not the previous raw target
 * which the animated marker may not have reached. This prevents a forward spike
 * and a returning stroke when GPS arrives before the old tween finishes.
 */
export class LiveRouteTail {
  private scope: string | null = null
  private target: TailFix | null = null
  private anchor: TailFix | null = null
  private displayed: TailCoordinate | null = null
  private vertices: Vertex[] = []
  private history: TailFrame['history'] = []
  private tip: TailFrame['tip'] = EMPTY
  private blockedThrough = -Infinity
  private mayBridge = true
  private waitingForTarget = false

  constructor(private readonly render: (frame: TailFrame) => void) {}

  reset() {
    this.scope = null; this.target = null; this.anchor = null; this.displayed = null
    this.vertices = []; this.history = []; this.tip = EMPTY
    this.mayBridge = true; this.blockedThrough = -Infinity; this.waitingForTarget = false
    this.publish()
  }

  /** Do not connect across hidden/paused/denied intervals or replay their old fix. */
  interrupt(now: number) {
    const barrier = Math.max(this.blockedThrough, now)
    this.reset()
    this.mayBridge = false; this.blockedThrough = barrier
  }

  update(scope: string, fix: TailFix, anchor: TailFix | null, now: number) {
    if (!valid(fix) || fix.observedAt <= this.blockedThrough ||
      now - fix.observedAt > MAX_GAP_MS || now - fix.observedAt < -5000) return
    if (this.scope && this.scope !== scope) {
      this.reset()
      this.mayBridge = false
    }
    this.scope = scope
    // Only the endpoint of geometry ALREADY installed on the map is an anchor.
    // A snapshot's lastSampleAt or truncated projection's remote endPoint is not.
    if (anchor && valid(anchor) && (!this.anchor || anchor.observedAt >= this.anchor.observedAt)) this.anchor = copy(anchor)
    const previous = this.target
    if (previous && (fix.observedAt < previous.observedAt ||
      (fix.observedAt === previous.observedAt && !same(fix.coordinate, previous.coordinate)))) return
    if (!previous) {
      const start = this.mayBridge && this.anchor && continuous(this.anchor, fix) ? this.anchor : fix
      this.vertices = [{ ...copy(start), breakBefore: true }]
      this.displayed = start.coordinate
      this.waitingForTarget = start === fix
      this.rebuildHistory()
      this.mayBridge = true
    } else if (fix.observedAt > previous.observedAt && !same(fix.coordinate, previous.coordinate)) {
      const shown = this.displayed ?? previous.coordinate
      this.append({ coordinate: shown, observedAt: previous.observedAt }, false)
      if (!continuous(previous, fix) || meters(shown, fix.coordinate) > MAX_JUMP_M) {
        this.append(fix, true)
        this.displayed = fix.coordinate
        this.waitingForTarget = true
      }
      this.tip = EMPTY
      this.rebuildHistory()
    }
    this.target = copy(fix)
    this.reconcile()
    this.publish()
  }

  paint(coordinate: TailCoordinate) {
    const target = this.target
    if (!target || !coordinate.every(Number.isFinite) || Math.abs(coordinate[0]) > 90 || Math.abs(coordinate[1]) > 180) return
    if (this.waitingForTarget) {
      if (!same(coordinate, target.coordinate)) return
      this.waitingForTarget = false
    }
    const last = this.vertices.at(-1)
    if (!last) return
    // A provider/motion discontinuity must not create a long imaginary segment.
    if (meters(last.coordinate, coordinate) > MAX_JUMP_M) {
      this.append({ coordinate, observedAt: target.observedAt }, true)
      this.rebuildHistory()
    }
    const from = this.vertices.at(-1)!.coordinate
    const next = same(from, coordinate) ? EMPTY : [from, [coordinate[0], coordinate[1]] as TailCoordinate]
    const changed = !this.displayed || !same(this.displayed, coordinate) || this.tip.length !== next.length
    this.displayed = [coordinate[0], coordinate[1]]
    this.tip = next
    // No prefix walk on normal animation frames. A complete catch-up can retire
    // the preview once, at the endpoint, without disappearing mid-animation.
    if (same(coordinate, target.coordinate) && this.anchor && this.anchor.observedAt >= target.observedAt && same(this.anchor.coordinate, target.coordinate)) {
      if (this.vertices.length === 1 && this.history.length === 0 && next.length === 0) return
      this.vertices = [{ ...copy(target), breakBefore: true }]
      this.history = []; this.tip = EMPTY
      this.publish()
    } else if (changed) this.publish()
  }

  private append(fix: TailFix, breakBefore: boolean) {
    const last = this.vertices.at(-1)
    if (last && !breakBefore && same(last.coordinate, fix.coordinate)) {
      this.vertices[this.vertices.length - 1] = { ...last, observedAt: fix.observedAt }
      return
    }
    this.vertices.push({ ...copy(fix), breakBefore })
    if (this.vertices.length > LIVE_TAIL_MAX_VERTICES) {
      this.vertices = this.vertices.slice(-LIVE_TAIL_MAX_VERTICES)
      this.vertices[0] = { ...this.vertices[0]!, breakBefore: true }
    }
  }

  private reconcile() {
    const anchor = this.anchor, target = this.target
    if (!anchor || !target) return
    if (anchor.observedAt >= target.observedAt && same(anchor.coordinate, target.coordinate) && this.displayed && same(this.displayed, target.coordinate)) {
      this.vertices = [{ ...copy(target), breakBefore: true }]
      this.history = []; this.tip = EMPTY
      return
    }
    // Timestamps alone are insufficient: stationary display stabilization can
    // retain an older coordinate with a newer time. Wait for actual geometry.
    // Retire a prefix only at a matching drawn vertex. Do not replace a visual
    // corner by a straight line to a newer server endpoint ahead of the icon.
    const index = this.vertices.findIndex(vertex => vertex.observedAt === anchor.observedAt && same(vertex.coordinate, anchor.coordinate))
    if (index > 0) {
      this.vertices = this.vertices.slice(index)
      this.vertices[0] = { ...this.vertices[0]!, breakBefore: true }
      this.rebuildHistory()
    }
  }

  private rebuildHistory() {
    const segments: TailCoordinate[][] = []
    for (const vertex of this.vertices) {
      if (!segments.length || vertex.breakBefore) segments.push([])
      segments.at(-1)!.push(vertex.coordinate)
    }
    this.history = segments.filter(segment => segment.length > 1)
  }
  private publish() { this.render({ history: this.history, tip: this.tip }) }
}

/** A flock containing the navigator can still be anchored to the VIEWER.
 * Never turn that participant's GPS into a new leg of the navigator's route. */
export function navigatorMotionMarker<T extends { id: string; members: readonly string[]; kind: string; stale: boolean }>(
  markers: readonly T[], identityId: string, navigatorId: string | null,
): T | null {
  if (!navigatorId) return null
  return markers.find(marker => !marker.stale && (marker.members.length
    ? marker.members.includes(navigatorId) && (identityId === navigatorId || !marker.members.includes(identityId))
    : identityId === navigatorId ? marker.id === 'viewer' && marker.kind === 'navigator' : marker.id === 'navigator')) ?? null
}
