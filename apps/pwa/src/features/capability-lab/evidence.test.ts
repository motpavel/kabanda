import { describe, expect, it } from 'vitest'
import { buildGeoJson } from './evidence'
import type { GpsSample } from './types'

function sample(id: string, latitude: number, longitude: number, capturedAt: string): GpsSample {
  return {
    id,
    sessionId: 'session-1',
    capturedAt,
    latitude,
    longitude,
    accuracy: 10,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  }
}

describe('buildGeoJson', () => {
  it('exports no fake route without GPS samples', () => {
    expect(buildGeoJson([])).toEqual({ type: 'FeatureCollection', features: [] })
  })

  it('keeps route order and coordinates', () => {
    const route = buildGeoJson([
      sample('one', 56.85, 53.2, '2026-08-28T08:00:00.000Z'),
      sample('two', 56.86, 53.21, '2026-08-28T08:01:00.000Z'),
    ])

    expect(route.features[0]?.geometry.coordinates).toEqual([
      [53.2, 56.85, null],
      [53.21, 56.86, null],
    ])
    expect(route.features[0]?.properties).toMatchObject({
      sampleCount: 2,
      startedAt: '2026-08-28T08:00:00.000Z',
      endedAt: '2026-08-28T08:01:00.000Z',
    })
  })
})

