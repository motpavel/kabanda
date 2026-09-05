import type { NearbyPoint, OneShotCoordinate } from '../../checkins/types'
import type { RaidMapPoint } from '../types'

// This is only a local suggestion. The server still validates each GPS fix,
// radius, accuracy, participant and duplicate before giving any credit.
export function nearbyCachedPoints(points: readonly RaidMapPoint[], coordinate: OneShotCoordinate): NearbyPoint[] {
  const radians = (degrees: number) => degrees * Math.PI / 180
  return points.map((point) => {
    const a = Math.sin(radians(point.latitude - coordinate.latitude) / 2) ** 2
      + Math.cos(radians(point.latitude)) * Math.cos(radians(coordinate.latitude))
      * Math.sin(radians(point.longitude - coordinate.longitude) / 2) ** 2
    return {
      pointSnapshotId: point.id, sourcePointId: point.sourcePointId, name: point.name,
      latitude: point.latitude, longitude: point.longitude,
      distanceMeters: 12_742_000 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))),
      creditedByMe: point.visitedByMe, creditedByTeam: point.visitedByTeam,
    }
  }).filter((point) => point.distanceMeters <= 50)
    .sort((left, right) => left.distanceMeters - right.distanceMeters).slice(0, 5)
}
