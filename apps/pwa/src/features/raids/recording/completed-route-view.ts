type VisitFlags = { visitedByMe?: boolean; visitedByTeam?: boolean }
type Coordinate = { latitude: number; longitude: number }
type OverviewTrack = {
  segments: readonly (readonly Coordinate[])[]
  startPoint?: Coordinate | null
  endPoint?: Coordinate | null
  truncated: boolean
}

/** These are the current raid's confirmed flags, not accumulated visits,
 * proximity, photos or pending local check-ins. Never modify source records. */
export function isVisitedRaidPoint(point: VisitFlags): boolean {
  return point.visitedByMe === true || point.visitedByTeam === true
}

export function pointsForRaidMap<T extends VisitFlags>(points: readonly T[], completed: boolean): readonly T[] {
  return completed ? points.filter(isVisitedRaidPoint) : points
}

/** Wait for the route before choosing its overview. Otherwise an earlier
 * catalogue response locks the camera onto stops and crops the actual ride.
 * A confirmed empty route may still be framed by its visited stops. */
export function completedRouteBoundsPoints<T extends Coordinate & VisitFlags>(
  track: OverviewTrack | null,
  points: readonly T[],
): readonly Coordinate[] {
  if (!track || track.truncated) return []
  return [
    ...track.segments.flat(),
    ...(track.startPoint ? [track.startPoint] : []),
    ...(track.endPoint ? [track.endPoint] : []),
    ...points.filter(isVisitedRaidPoint),
  ]
}
