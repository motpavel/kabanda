import { describe, expect, it, vi } from 'vitest'
import type {
  YandexEvent,
  YandexEventHandler,
  YandexMap,
  YandexMapsRuntime,
} from '../kabandas/yandex-maps'
import {
  attachBicycleRoute,
  attachNumberedWaypointPlacemark,
  normalizeYandexRouteFailure,
  straightLineDistanceMeters,
  type BicycleRouteState,
} from './yandex-adapter'

describe('straightLineDistanceMeters', () => {
  it('returns zero until a route has at least two points', () => {
    expect(straightLineDistanceMeters([])).toBe(0)
    expect(straightLineDistanceMeters([{ latitude: 56.85, longitude: 53.2 }])).toBe(0)
  })

  it('sums geodesic distances between consecutive points', () => {
    const oneDegreeAtEquatorMeters = straightLineDistanceMeters([
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 1 },
    ])
    const twoSegmentsMeters = straightLineDistanceMeters([
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 1 },
      { latitude: 0, longitude: 2 },
    ])

    expect(oneDegreeAtEquatorMeters).toBeCloseTo(111_194.93, 1)
    expect(twoSegmentsMeters).toBeCloseTo(oneDegreeAtEquatorMeters * 2, 6)
  })
})

describe('normalizeYandexRouteFailure', () => {
  it('normalizes invalid-key and authorization failures', () => {
    expect(normalizeYandexRouteFailure(new Error('Invalid api key'))).toBe('api_key_rejected')
    expect(normalizeYandexRouteFailure({ status: 403 })).toBe('api_key_rejected')
  })

  it('keeps provider failures distinct from no-route and unknown failures', () => {
    expect(normalizeYandexRouteFailure({ message: 'Route not found' })).toBe('no_route')
    expect(normalizeYandexRouteFailure({ status: 503 })).toBe('provider_unavailable')
    expect(normalizeYandexRouteFailure({ message: 'Counter total limit exceeded' })).toBe('provider_unavailable')
    expect(normalizeYandexRouteFailure({ message: 'Unexpected response shape' })).toBe('unknown')
  })
})

describe('attachNumberedWaypointPlacemark', () => {
  it('selects the existing point without bubbling a second map click', () => {
    const eventHandlers = new Map<string, YandexEventHandler>()
    const placemark = {
      events: {
        add: (name: string, handler: YandexEventHandler) => eventHandlers.set(name, handler),
        remove: (name: string) => eventHandlers.delete(name),
      },
    }
    const runtime = {
      Placemark: class {
        constructor() {
          return placemark
        }
      },
    } as unknown as YandexMapsRuntime
    const map = {
      geoObjects: {
        add: vi.fn(),
        remove: vi.fn(),
      },
    } as unknown as YandexMap
    const onSelect = vi.fn()
    const stopPropagation = vi.fn()

    const dispose = attachNumberedWaypointPlacemark(
      runtime,
      map,
      { latitude: 56.85, longitude: 53.2 },
      1,
      { onSelect },
    )
    const clickEvent: YandexEvent = {
      get: <Value,>() => undefined as Value,
      stopPropagation,
    }
    eventHandlers.get('click')?.(clickEvent)

    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledOnce()
    expect(stopPropagation.mock.invocationCallOrder[0]).toBeLessThan(onSelect.mock.invocationCallOrder[0]!)

    dispose()
    expect(map.geoObjects.remove).toHaveBeenCalledWith(placemark)
  })
})

describe('attachBicycleRoute', () => {
  it('uses the lat-lon bicycle contract and contains provider failure events', () => {
    const eventHandlers = new Map<string, YandexEventHandler>()
    let modelInput: unknown
    const route = {
      model: {
        events: {
          add: (name: string, handler: YandexEventHandler) => eventHandlers.set(name, handler),
          remove: (name: string) => eventHandlers.delete(name),
        },
      },
      getActiveRoute: () => null,
    }
    const runtime = {
      multiRouter: {
        MultiRoute: class {
          constructor(input: unknown) {
            modelInput = input
            return route
          }
        },
      },
    } as unknown as YandexMapsRuntime
    const map = {
      geoObjects: {
        add: vi.fn(),
        remove: vi.fn(),
      },
    } as unknown as YandexMap
    const states: BicycleRouteState[] = []

    const dispose = attachBicycleRoute(runtime, map, [
      { latitude: 56.85, longitude: 53.2 },
      { latitude: 56.86, longitude: 53.21 },
    ], (state) => states.push(state))

    expect(modelInput).toEqual({
      referencePoints: [[56.85, 53.2], [56.86, 53.21]],
      params: {
        routingMode: 'bicycle',
        reverseGeocoding: false,
        results: 1,
      },
    })
    expect(states[0]).toMatchObject({ status: 'calculating' })

    const failureEvent: YandexEvent = {
      get: <Value,>() => new Error('Invalid api key') as unknown as Value,
    }
    expect(() => eventHandlers.get('requestfail')?.(failureEvent)).not.toThrow()
    expect(states.at(-1)).toMatchObject({
      status: 'failed',
      code: 'api_key_rejected',
    })

    dispose()
    expect(map.geoObjects.remove).toHaveBeenCalledWith(route)
  })
})
