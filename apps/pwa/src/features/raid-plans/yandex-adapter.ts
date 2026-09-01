import {
  loadYandexMaps,
  type YandexCoordinates,
  type YandexEvent,
  type YandexEventHandler,
  type YandexMap,
  type YandexMapsRuntime,
  type YandexMultiRoute,
  type YandexPlacemark,
} from '../kabandas/yandex-maps'
import type { RaidTemplateFailureCode } from './types'

const EARTH_RADIUS_METERS = 6_371_000

export type RaidPlanGeoPoint = Readonly<{
  latitude: number
  longitude: number
}>

export type BicycleRouteState =
  | {
      status: 'calculating'
      fallbackDistanceMeters: number
    }
  | {
      status: 'ready'
      distanceMeters: number
      fallbackDistanceMeters: number
    }
  | {
      status: 'failed'
      code: RaidTemplateFailureCode
      fallbackDistanceMeters: number
    }

export type DisposeYandexAttachment = () => undefined

export type NumberedWaypointPlacemarkOptions = {
  selected?: boolean
  onSelect?: () => void
}

export function loadRaidPlanYandex(apiKey: string) {
  return loadYandexMaps(apiKey)
}

export function toYandexCoordinates(point: RaidPlanGeoPoint): YandexCoordinates {
  return [point.latitude, point.longitude]
}

export function fromYandexCoordinates(coordinates: YandexCoordinates): RaidPlanGeoPoint {
  return {
    latitude: coordinates[0],
    longitude: coordinates[1],
  }
}

export function attachRaidPlanMapClick(
  map: YandexMap,
  onPoint: (point: RaidPlanGeoPoint) => void,
): DisposeYandexAttachment {
  const handleClick: YandexEventHandler = (event) => {
    const coordinates = event.get<YandexCoordinates | undefined>('coords')
    if (!coordinates || !coordinates.every(Number.isFinite)) return
    onPoint(fromYandexCoordinates(coordinates))
  }

  map.events.add('click', handleClick)
  return () => {
    map.events.remove?.('click', handleClick)
    return undefined
  }
}

export function attachNumberedWaypointPlacemark(
  runtime: YandexMapsRuntime,
  map: YandexMap,
  point: RaidPlanGeoPoint,
  number: number,
  options: NumberedWaypointPlacemarkOptions = {},
): DisposeYandexAttachment {
  const placemark: YandexPlacemark = new runtime.Placemark(toYandexCoordinates(point), {
    iconContent: String(number),
  }, {
    preset: options.selected ? 'islands#redStretchyIcon' : 'islands#blueStretchyIcon',
    hasBalloon: false,
    openBalloonOnClick: false,
  })

  const handleSelect: YandexEventHandler | null = options.onSelect
    ? (event) => {
        event.stopPropagation?.()
        options.onSelect?.()
      }
    : null
  if (handleSelect) placemark.events.add('click', handleSelect)

  map.geoObjects.add(placemark)
  return () => {
    if (handleSelect) placemark.events.remove?.('click', handleSelect)
    map.geoObjects.remove(placemark)
    return undefined
  }
}

const toRadians = (degrees: number) => degrees * Math.PI / 180

function pointDistanceMeters(from: RaidPlanGeoPoint, to: RaidPlanGeoPoint) {
  const latitudeDelta = toRadians(to.latitude - from.latitude)
  const longitudeDelta = toRadians(to.longitude - from.longitude)
  const fromLatitude = toRadians(from.latitude)
  const toLatitude = toRadians(to.latitude)
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2
  const safeHaversine = Math.min(1, Math.max(0, haversine))

  return EARTH_RADIUS_METERS * 2 * Math.atan2(
    Math.sqrt(safeHaversine),
    Math.sqrt(1 - safeHaversine),
  )
}

export function straightLineDistanceMeters(points: readonly RaidPlanGeoPoint[]) {
  let distanceMeters = 0
  for (let index = 1; index < points.length; index += 1) {
    distanceMeters += pointDistanceMeters(points[index - 1]!, points[index]!)
  }
  return distanceMeters
}

function errorDetails(error: unknown) {
  if (typeof error === 'string') return { message: error, status: null }
  if (!error || typeof error !== 'object') return { message: '', status: null }

  const record = error as Record<string, unknown>
  const messageParts = [
    error instanceof Error ? error.message : null,
    record.message,
    record.description,
    record.code,
    record.statusText,
  ]
    .filter((value): value is string => typeof value === 'string')
  const statusCandidate = record.status ?? record.statusCode
  const status = typeof statusCandidate === 'number'
    ? statusCandidate
    : typeof statusCandidate === 'string' && /^\d{3}$/.test(statusCandidate)
      ? Number(statusCandidate)
      : null

  return { message: messageParts.join(' '), status }
}

export function normalizeYandexRouteFailure(error: unknown): RaidTemplateFailureCode {
  const { message, status } = errorDetails(error)
  const normalized = message.toLocaleLowerCase('en-US')

  if (
    status === 401 ||
    status === 403 ||
    /\b40[13]\b|api[\s_-]*key|invalid key|key not found|unauthori[sz]ed|forbidden|referer/.test(normalized)
  ) return 'api_key_rejected'

  if (/no route|route not found|cannot build|could not build|маршрут не найден/.test(normalized)) {
    return 'no_route'
  }

  if (
    status === 429 ||
    (status !== null && status >= 500) ||
    /\b429\b|\b5\d\d\b|quota|limit exceeded|too many requests|network|failed to fetch|timeout|timed out|unavailable/.test(normalized)
  ) return 'provider_unavailable'

  return 'unknown'
}

function routeDistanceMeters(route: YandexMultiRoute) {
  const activeRoute = route.getActiveRoute()
  if (!activeRoute) return null

  const distance = activeRoute.properties.get<unknown>('distance')
  if (typeof distance === 'number' && Number.isFinite(distance) && distance >= 0) return distance
  if (!distance || typeof distance !== 'object') return null

  const value = (distance as Record<string, unknown>).value
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function attachBicycleRoute(
  runtime: YandexMapsRuntime,
  map: YandexMap,
  points: readonly RaidPlanGeoPoint[],
  onState: (state: BicycleRouteState) => void,
): DisposeYandexAttachment {
  if (points.length < 2) return () => undefined

  const fallbackDistanceMeters = straightLineDistanceMeters(points)
  let disposed = false
  let route: YandexMultiRoute | null = null
  let handleSuccess: YandexEventHandler | null = null
  let handleFailure: YandexEventHandler | null = null

  const emit = (state: BicycleRouteState) => {
    if (!disposed) onState(state)
  }

  const dispose: DisposeYandexAttachment = () => {
    if (disposed) return undefined
    disposed = true
    if (!route) return undefined
    if (handleSuccess) route.model.events.remove?.('requestsuccess', handleSuccess)
    if (handleFailure) route.model.events.remove?.('requestfail', handleFailure)
    map.geoObjects.remove(route)
    return undefined
  }

  emit({ status: 'calculating', fallbackDistanceMeters })

  try {
    route = new runtime.multiRouter.MultiRoute({
      referencePoints: points.map(toYandexCoordinates),
      params: {
        routingMode: 'bicycle',
        reverseGeocoding: false,
        results: 1,
      },
    }, {
      boundsAutoApply: true,
    })

    handleSuccess = () => {
      if (!route) return
      const distanceMeters = routeDistanceMeters(route)
      if (distanceMeters === null) {
        emit({ status: 'failed', code: 'no_route', fallbackDistanceMeters })
        return
      }
      emit({ status: 'ready', distanceMeters, fallbackDistanceMeters })
    }
    handleFailure = (event: YandexEvent) => {
      emit({
        status: 'failed',
        code: normalizeYandexRouteFailure(event.get('error')),
        fallbackDistanceMeters,
      })
    }

    route.model.events.add('requestsuccess', handleSuccess)
    route.model.events.add('requestfail', handleFailure)
    map.geoObjects.add(route)
  } catch (error) {
    if (route && handleSuccess) route.model.events.remove?.('requestsuccess', handleSuccess)
    if (route && handleFailure) route.model.events.remove?.('requestfail', handleFailure)
    route = null
    emit({
      status: 'failed',
      code: normalizeYandexRouteFailure(error),
      fallbackDistanceMeters,
    })
  }

  return dispose
}
