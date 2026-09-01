export type RouteCoordinate = readonly [number, number]

export const ROUTE_START: RouteCoordinate = [56.852903, 53.202193]
export const ROUTE_DESTINATION: RouteCoordinate = [56.852952, 53.223375]

// Used only as deterministic endpoint data. The visible geometry is requested
// from Yandex in bicycle mode, so the prototype never invents a line over houses.
export const TEST_ROUTE: readonly RouteCoordinate[] = [
  ROUTE_START,
  [56.853041, 53.203167],
  [56.853196, 53.204254],
  [56.853309, 53.205497],
  [56.853407, 53.206814],
  [56.853535, 53.208105],
  [56.853714, 53.209423],
  [56.853896, 53.210743],
  [56.854027, 53.212119],
  [56.854113, 53.213536],
  [56.854172, 53.214901],
  [56.854041, 53.216238],
  [56.853872, 53.217474],
  [56.853699, 53.218632],
  [56.853491, 53.219733],
  [56.853306, 53.220811],
  [56.853184, 53.221747],
  [56.853089, 53.222481],
  ROUTE_DESTINATION,
] as const

const toRadians = (value: number) => value * Math.PI / 180

export function distanceMeters(from: RouteCoordinate, to: RouteCoordinate) {
  const earthRadius = 6_371_000
  const latitudeDelta = toRadians(to[0] - from[0])
  const longitudeDelta = toRadians(to[1] - from[1])
  const fromLatitude = toRadians(from[0])
  const toLatitude = toRadians(to[0])
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function routeDistance(coordinates: readonly RouteCoordinate[]) {
  return coordinates.slice(1).reduce(
    (total, coordinate, index) => total + distanceMeters(coordinates[index]!, coordinate),
    0,
  )
}

export const TEST_ROUTE_DISTANCE_M = routeDistance(TEST_ROUTE)

export function interpolateCoordinate(
  from: RouteCoordinate,
  to: RouteCoordinate,
  progress: number,
): RouteCoordinate {
  const safeProgress = Math.min(1, Math.max(0, progress))
  return [
    from[0] + (to[0] - from[0]) * safeProgress,
    from[1] + (to[1] - from[1]) * safeProgress,
  ]
}

export function splitRouteAtDistance(
  coordinates: readonly RouteCoordinate[],
  requestedDistanceM: number,
) {
  if (!coordinates.length) {
    return { current: null, remaining: [] as RouteCoordinate[], traveled: [] as RouteCoordinate[] }
  }

  const totalDistanceM = routeDistance(coordinates)
  const targetDistanceM = Math.min(totalDistanceM, Math.max(0, requestedDistanceM))
  const first = coordinates[0]!

  if (coordinates.length === 1 || targetDistanceM === 0) {
    return { current: first, remaining: [...coordinates], traveled: [first] }
  }

  let traversedDistanceM = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    const from = coordinates[index - 1]!
    const to = coordinates[index]!
    const segmentDistanceM = distanceMeters(from, to)
    const nextDistanceM = traversedDistanceM + segmentDistanceM

    if (targetDistanceM <= nextDistanceM && segmentDistanceM > 0) {
      const progress = (targetDistanceM - traversedDistanceM) / segmentDistanceM
      const current = interpolateCoordinate(from, to, progress)
      const traveled = [...coordinates.slice(0, index), current]
      const remaining = [current, ...coordinates.slice(index)]
      return { current, remaining, traveled }
    }

    traversedDistanceM = nextDistanceM
  }

  const last = coordinates.at(-1)!
  return { current: last, remaining: [last], traveled: [...coordinates] }
}
