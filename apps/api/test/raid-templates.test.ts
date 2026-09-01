import { createRaidTemplateSchema } from '@kabanda/contracts'
import { describe, expect, it } from 'vitest'
import { straightSegmentsDistanceMeters } from '../src/raid-templates.js'

describe('raid template distance', () => {
  it('computes and rounds the Haversine sum in the submitted point order', () => {
    const oneSegment = straightSegmentsDistanceMeters([
      { name: 'A', address: 'A', comment: '', latitude: 0, longitude: 0 },
      { name: 'B', address: 'B', comment: '', latitude: 0, longitude: 1 },
    ])
    const twoSegments = straightSegmentsDistanceMeters([
      { name: 'A', address: 'A', comment: '', latitude: 0, longitude: 0 },
      { name: 'B', address: 'B', comment: '', latitude: 0, longitude: 1 },
      { name: 'C', address: 'C', comment: '', latitude: 0, longitude: 2 },
    ])

    expect(oneSegment).toBe(111_195)
    expect(twoSegments).toBe(222_390)
  })

  it('allows a zero straight-segment estimate for coincident points', () => {
    expect(straightSegmentsDistanceMeters([
      { name: 'A', address: 'A', comment: '', latitude: 56.85, longitude: 53.2 },
      { name: 'B', address: 'B', comment: '', latitude: 56.85, longitude: 53.2 },
    ])).toBe(0)
  })
})

describe('raid template access contract', () => {
  const legacyRequest = {
    title: 'Маршрут для своих',
    coverImage: 'data:image/jpeg;base64,YQ==',
    points: [
      { name: 'A', address: 'A', comment: '', latitude: 56.8, longitude: 53.2 },
      { name: 'B', address: 'B', comment: '', latitude: 56.9, longitude: 53.3 },
    ],
  }

  it('defaults a cached old client to Kabanda-only access', () => {
    expect(createRaidTemplateSchema.parse(legacyRequest).scope).toBe('kabanda')
  })

  it('rejects an unknown access value', () => {
    expect(() => createRaidTemplateSchema.parse({ ...legacyRequest, scope: 'anonymous' })).toThrow()
  })
})
