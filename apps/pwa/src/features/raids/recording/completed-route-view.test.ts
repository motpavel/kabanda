import { describe, expect, it } from 'vitest'
import { completedRouteBoundsPoints, isVisitedRaidPoint, pointsForRaidMap } from './completed-route-view'

const points = [
  { id: 'both', latitude: 56.86, longitude: 53.21, visitedByMe: true, visitedByTeam: true },
  { id: 'team', latitude: 56.862, longitude: 53.212, visitedByMe: false, visitedByTeam: true },
  { id: 'mine', latitude: 56.863, longitude: 53.213, visitedByMe: true, visitedByTeam: false },
  { id: 'missed', latitude: 10, longitude: -100, visitedByMe: false, visitedByTeam: false },
]
const start = { latitude: 56.859, longitude: 53.209 }
const end = { latitude: 56.869, longitude: 53.219 }
const track = { segments: [[start, end]], startPoint: start, endPoint: end, truncated: false }

function extent(rows: readonly { latitude: number; longitude: number }[]) {
  return [Math.min(...rows.map(point => point.latitude)), Math.max(...rows.map(point => point.latitude)),
    Math.min(...rows.map(point => point.longitude)), Math.max(...rows.map(point => point.longitude))]
}

describe('completed raid map visibility', () => {
  it('keeps personal and team-only green points in their original order', () => {
    expect(pointsForRaidMap(points, true).map(point => point.id)).toEqual(['both', 'team', 'mine'])
    expect(pointsForRaidMap(points, true)[1]).toBe(points[1])
  })
  it('does not hide team visits from someone without a personal credit', () => {
    expect(isVisitedRaidPoint({ visitedByMe: false, visitedByTeam: true })).toBe(true)
  })
  it('uses the same predicate for the visited list and map', () => {
    expect(points.filter(isVisitedRaidPoint)).toEqual(pointsForRaidMap(points, true))
  })
  it('keeps the entire original catalogue for non-completed maps', () => {
    expect(pointsForRaidMap(points, false)).toBe(points)
    expect(pointsForRaidMap(points, false)).toHaveLength(4)
  })
  it('never falls back to red pins when there are no visits', () => {
    expect(pointsForRaidMap([points[3]!], true)).toEqual([])
    expect(pointsForRaidMap([], true)).toEqual([])
  })
  it('does not infer credit from pending operations, photos or proximity', () => {
    const unconfirmed = { ...points[3]!, pending: true, photoCount: 2, distanceMeters: 0 }
    expect(pointsForRaidMap([unconfirmed], true)).toEqual([])
    expect(isVisitedRaidPoint({})).toBe(false)
    expect(isVisitedRaidPoint({ visitedByMe: undefined, visitedByTeam: undefined })).toBe(false)
  })
  it('keeps the complete ride and excludes far-away unvisited stops from bounds', () => {
    expect(extent(completedRouteBoundsPoints(track, points))).toEqual(extent([start, end]))
    expect(completedRouteBoundsPoints(track, points)).not.toContain(points[3])
  })
  it('includes visited stops outside sparse track segments in the overview', () => {
    const stop = { latitude: 56.87, longitude: 53.22, visitedByTeam: true }
    expect(extent(completedRouteBoundsPoints(track, [stop]))).toEqual(extent([start, end, stop]))
  })
  it('preserves start and finish even when only singleton segments are present', () => {
    expect(completedRouteBoundsPoints({ ...track, segments: [[start]] }, [])).toContain(end)
    expect(completedRouteBoundsPoints({ ...track, segments: [] }, [])).toEqual([start, end])
  })
  it('waits for late or paginated route geometry, not the catalogue', () => {
    expect(completedRouteBoundsPoints(null, points)).toEqual([])
    expect(completedRouteBoundsPoints({ ...track, truncated: true }, points)).toEqual([])
    expect(completedRouteBoundsPoints(track, points)).toContain(end)
  })
  it('can frame visited stops when the confirmed route has no GPS', () => {
    expect(completedRouteBoundsPoints({ segments: [], truncated: false }, points)).toEqual(points.slice(0, 3))
  })
  it('keeps an empty result empty and a route without visits visible', () => {
    expect(completedRouteBoundsPoints({ segments: [], truncated: false }, [points[3]!])).toEqual([])
    expect(completedRouteBoundsPoints(track, [points[3]!])).toContain(start)
    expect(completedRouteBoundsPoints(track, [points[3]!])).toContain(end)
  })
  it('does not mutate frozen cached data, coordinates or credit flags', () => {
    const immutablePoints = Object.freeze(points.map(point => Object.freeze({ ...point })))
    const immutableTrack = Object.freeze({ ...track, segments: Object.freeze([Object.freeze([Object.freeze({ ...start }), Object.freeze({ ...end })])]) })
    const before = JSON.stringify([immutablePoints, immutableTrack])
    pointsForRaidMap(immutablePoints, true)
    completedRouteBoundsPoints(immutableTrack, immutablePoints)
    expect(JSON.stringify([immutablePoints, immutableTrack])).toBe(before)
  })
})
