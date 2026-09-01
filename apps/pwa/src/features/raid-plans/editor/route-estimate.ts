import type { DraftRaidTemplatePoint } from '../types'

const EARTH_RADIUS_METERS = 6_371_000

export function geodesicRouteDistance(points: readonly Pick<DraftRaidTemplatePoint, 'latitude' | 'longitude'>[]): number {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    if (!previous || !current) continue
    total += distanceMeters(previous, current)
  }
  return Math.max(0, Math.round(total))
}

export function formatPlanDistance(distanceMeters: number): string {
  if (distanceMeters < 1_000) return `${Math.max(0, Math.round(distanceMeters))} м`
  return `${(distanceMeters / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`
}

function distanceMeters(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number },
): number {
  const leftLatitude = radians(left.latitude)
  const rightLatitude = radians(right.latitude)
  const latitudeDelta = radians(right.latitude - left.latitude)
  const longitudeDelta = radians(right.longitude - left.longitude)
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function radians(value: number): number {
  return value * Math.PI / 180
}
