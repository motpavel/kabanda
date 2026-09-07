import { describe, expect, it } from 'vitest'
import { trackEndpoints } from './track-endpoints'
const a = { latitude: 56.85, longitude: 53.2, capturedAt: '2026-09-07T10:00:00Z' }
const b = { ...a, longitude: 53.21 }
const track = { segments: [[a], [], [b]], pointCount: 2, truncated: false, updatedAt: null, serverAt: '' }
describe('route endpoint markers', () => {
  it('shows only start until completed', () => expect(trackEndpoints(track, false).map(p => p.kind)).toEqual(['start']))
  it('takes start and finish across disconnected segments', () => expect(trackEndpoints(track, true).map(p => p.point)).toEqual([a, b]))
  it('combines a round trip into one label', () => expect(trackEndpoints({ ...track, endPoint: a }, true)[0]?.kind).toBe('both'))
  it('uses actual server finish beyond the truncated drawn track', () => expect(trackEndpoints({ ...track, truncated: true, endPoint: b }, true).at(-1)?.point).toEqual(b))
  it('does not label a truncated sample as finish', () => expect(trackEndpoints({ ...track, truncated: true }, true).map(p => p.kind)).toEqual(['start']))
  it('does not invent coordinates for an empty track', () => expect(trackEndpoints({ ...track, segments: [] }, true)).toEqual([]))
})
