import type { OneShotCoordinate } from '../../checkins/types'
import type { RouteTrackProjection } from '../types'
import type { LivePosition } from '../live-feed'
import { selectRiderMarkers, riderDistanceMeters, type RiderMarker } from './rider-markers'
import { StationaryDisplay } from './stationary-display'

export type FlockMarker = Omit<RiderMarker, 'id'> & { id: string; members: string[] }
type Pair = { outsideAt: number | null; lastFix: string }
const fresh = (point: OneShotCoordinate, now: number) => {
  const age = now - Date.parse(point.capturedAt)
  return Number.isFinite(age) && age >= -5000 && age <= 30_000 && point.accuracyMeters <= 50
}

/** All grouping and stabilization is visual. Stored evidence, clock timestamps,
 * participant membership and point-credit policies are not modified. */
export class FlockDisplay {
  private readonly displays = new Map<string, StationaryDisplay>()
  private readonly joined = new Map<string, Pair>()
  private navigatorId: string | null = null
  reset() { this.displays.clear(); this.joined.clear(); this.navigatorId = null }
  select(input: {
    identityId: string; navigatorUserId: string | null; navigatorSampleAt: string | null
    location: OneShotCoordinate | null; track: RouteTrackProjection | null
    positions?: readonly LivePosition[]; live: boolean; now: number
  }): FlockMarker[] {
    if (input.positions === undefined) return selectRiderMarkers(input).map(marker => ({ ...marker, members: [] }))
    if (this.navigatorId !== input.navigatorUserId) {
      this.joined.clear()
      this.navigatorId = input.navigatorUserId
    }
    const positions = new Map<string, OneShotCoordinate>()
    if (input.live) for (const point of input.positions) positions.set(point.userId, point)
    if (input.location) {
      const server = positions.get(input.identityId)
      if (!server || Date.parse(input.location.capturedAt) >= Date.parse(server.capturedAt)) positions.set(input.identityId, input.location)
    }
    for (const id of this.displays.keys()) if (!positions.has(id)) this.displays.delete(id)
    const raw = [...positions].sort(([a], [b]) => a.localeCompare(b))
    const parents = new Map(raw.map(([id]) => [id, id]))
    const root = (id: string): string => {
      let current = id
      while (parents.get(current) !== current) current = parents.get(current)!
      return current
    }
    const activePairs = new Set<string>()
    for (let i = 0; i < raw.length; i++) for (let j = i + 1; j < raw.length; j++) {
      const [aId, a] = raw[i]!, [bId, b] = raw[j]!
      const key = JSON.stringify([aId, bId])
      activePairs.add(key)
      if (!fresh(a, input.now) || !fresh(b, input.now)) { this.joined.delete(key); continue }
      const distance = riderDistanceMeters(a, b)
      const previous = this.joined.get(key)
      const fix = `${a.capturedAt}:${b.capturedAt}`
      const observationTime = Math.min(Date.parse(a.capturedAt), Date.parse(b.capturedAt))
      if (distance <= 70 + 1e-6) this.joined.set(key, { outsideAt: null, lastFix: fix })
      else if (distance > 100 || !previous) this.joined.delete(key)
      else if (previous.lastFix !== fix) {
        if (previous.outsideAt !== null && observationTime - previous.outsideAt >= 8000) this.joined.delete(key)
        else this.joined.set(key, { outsideAt: previous.outsideAt ?? observationTime, lastFix: fix })
      }
      if (this.joined.has(key)) parents.set(root(bId), root(aId))
    }
    for (const key of this.joined.keys()) if (!activePairs.has(key)) this.joined.delete(key)
    const groups = new Map<string, string[]>()
    for (const [id] of raw) {
      const group = root(id)
      groups.set(group, [...(groups.get(group) ?? []), id])
    }
    const stabilized = new Map<string, OneShotCoordinate>()
    for (const [id, point] of raw) {
      let display = this.displays.get(id)
      if (!display) { display = new StationaryDisplay(); this.displays.set(id, display) }
      stabilized.set(id, display.update(point))
    }
    return [...groups.values()].map(members => {
      const anchorId = members.includes(input.identityId) ? input.identityId
        : input.navigatorUserId && members.includes(input.navigatorUserId) ? input.navigatorUserId : members[0]!
      const point = stabilized.get(anchorId)!
      const flock = members.length > 1
      const navigator = anchorId === input.navigatorUserId
      const stale = !fresh(positions.get(anchorId)!, input.now)
      const label = flock ? `Стая · ${members.length} участников рядом`
        : anchorId === input.identityId ? navigator ? 'Моё положение · навигатор' : 'Моё положение'
          : navigator ? 'Навигатор' : 'Участник рейда'
      return { id: flock ? `flock:${members.join(':')}` : anchorId === input.identityId ? 'viewer' : `rider:${anchorId}`,
        point, kind: flock ? 'flock' : navigator ? 'navigator' : 'participant',
        label: stale ? `${label} · последнее известное положение` : label, stale, members }
    })
  }
}
