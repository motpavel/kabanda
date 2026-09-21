export type MotionCoordinate = readonly [number, number]
export type MotionTarget = {
  id: string
  anchorId: string
  members: readonly string[]
  coordinate: MotionCoordinate
  observedAt: number
  stale: boolean
}
type Segment = MotionTarget & { from: MotionCoordinate; started: number; duration: number }
type MotionClock = {
  now: () => number
  request: (callback: (time: number) => void) => number
  cancel: (handle: number) => void
}

export const RIDER_MOTION_MAX_MS = 2000
const MAX_GAP_MS = 10_000
const MAX_JUMP_METERS = 250
const valid = (point: MotionTarget) => Number.isFinite(point.observedAt) &&
  point.coordinate.every(Number.isFinite) && Math.abs(point.coordinate[0]) <= 90 && Math.abs(point.coordinate[1]) <= 180
const same = (a: MotionCoordinate, b: MotionCoordinate) => a[0] === b[0] && a[1] === b[1]
const longitudeDelta = (a: number, b: number) => ((b - a + 540) % 360) - 180
const copy = (coordinate: MotionCoordinate): MotionCoordinate => [coordinate[0], coordinate[1]]
function distance(a: MotionCoordinate, b: MotionCoordinate) {
  const radians = Math.PI / 180
  const x = longitudeDelta(a[1], b[1]) * radians * Math.cos((a[0] + b[0]) * radians / 2)
  return Math.hypot((b[0] - a[0]) * radians, x) * 6_371_000
}
function position(segment: Segment, now: number): MotionCoordinate {
  if (!segment.duration || now >= segment.started + segment.duration) return segment.coordinate
  const fraction = Math.max(0, Math.min(1, (now - segment.started) / segment.duration))
  const longitude = segment.from[1] + longitudeDelta(segment.from[1], segment.coordinate[1]) * fraction
  return [segment.from[0] + (segment.coordinate[0] - segment.from[0]) * fraction, ((longitude + 540) % 360) - 180]
}

/** Presentation only: bounded interpolation towards a received position, never
 * dead reckoning. One RAF for all riders, no timers/network/React state/queues.
 * Clock is monotonic; source timestamps only reject reordering and size a move.
 * Duplicated snapshots do not restart animation. A new fix retargets the current
 * displayed position instead of rewinding to the previous GPS point.
 */
export class RiderMotion {
  private segments = new Map<string, Segment>()
  private painted = new Map<string, MotionCoordinate>()
  private frame: number | null = null
  private enabled = true
  private generation = 0
  constructor(private readonly render: (positions: ReadonlyMap<string, MotionCoordinate>) => void,
    private readonly clock: MotionClock) {}

  update(targets: readonly MotionTarget[]) {
    const now = this.clock.now()
    const previous = this.segments
    const byMember = new Map<string, Segment>()
    for (const segment of previous.values()) {
      byMember.set(segment.anchorId, segment)
      for (const member of segment.members) byMember.set(member, segment)
    }
    const next = new Map<string, Segment>()
    for (const target of targets) {
      if (!valid(target)) continue
      const existing = previous.get(target.id)
      // Membership keys change when joining/splitting. Continue from the old
      // visible flock position for that rider, not from a newly created pin.
      const source = existing?.anchorId === target.anchorId ? existing : byMember.get(target.anchorId)
      const sameAnchor = source?.anchorId === target.anchorId
      if (source && sameAnchor && (target.observedAt < source.observedAt ||
        (target.observedAt === source.observedAt && !same(target.coordinate, source.coordinate)))) {
        next.set(target.id, { ...source, id: target.id, members: [...target.members] })
        continue
      }
      const fixed: MotionTarget = { ...target, coordinate: copy(target.coordinate), members: [...target.members] }
      const gap = source && sameAnchor ? target.observedAt - source.observedAt : 1000
      const from = source ? position(source, now) : fixed.coordinate
      const discontinuity = !this.enabled || fixed.stale || source?.stale || gap > MAX_GAP_MS ||
        (source && now - source.started > MAX_GAP_MS) || distance(from, fixed.coordinate) > MAX_JUMP_METERS
      // Refreshing the timestamp at a held stationary coordinate must not keep
      // extending the same transition forever.
      if (existing && sameAnchor && same(existing.coordinate, fixed.coordinate) && !discontinuity) {
        next.set(target.id, { ...existing, ...fixed })
        continue
      }
      next.set(target.id, { ...fixed, from, started: now,
        duration: !source || discontinuity || same(from, fixed.coordinate) ? 0
          : Math.max(400, Math.min(RIDER_MOTION_MAX_MS, gap || 1000)) })
    }
    this.segments = next
    this.paint(now)
    this.schedule()
  }

  /** Hidden/reduced-motion/paused maps settle once, then consume no frames.
   * Restoring visibility does not play back a journey missed in the background. */
  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.cancel()
      for (const [id, segment] of this.segments) this.segments.set(id, { ...segment, from: segment.coordinate, duration: 0 })
      this.paint(this.clock.now())
    }
  }
  reset() {
    this.cancel()
    this.segments.clear()
    this.painted.clear()
  }
  private cancel() {
    this.generation++
    if (this.frame !== null) this.clock.cancel(this.frame)
    this.frame = null
  }
  private paint(now: number) {
    const coordinates = new Map<string, MotionCoordinate>()
    let changed = this.painted.size !== this.segments.size
    for (const [id, segment] of this.segments) {
      const coordinate = position(segment, now)
      coordinates.set(id, coordinate)
      const last = this.painted.get(id)
      if (!last || !same(last, coordinate)) changed = true
    }
    if (changed) { this.painted = coordinates; this.render(coordinates) }
  }
  private schedule() {
    const now = this.clock.now()
    const moving = this.enabled && [...this.segments.values()].some(segment => segment.duration && now < segment.started + segment.duration)
    if (!moving) { this.cancel(); return }
    if (this.frame !== null) return
    const generation = this.generation
    this.frame = this.clock.request(() => {
      if (generation !== this.generation) return
      this.frame = null
      // RAF timestamps mark the frame start and may precede a synchronous
      // update() in that frame. Use one monotonic clock for both paint paths.
      this.paint(this.clock.now())
      this.schedule()
    })
  }
}
