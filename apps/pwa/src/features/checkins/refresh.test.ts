import { describe, expect, it, vi } from 'vitest'
import { loadCheckInExtras } from './refresh'

describe('check-in extras refresh', () => {
  it('keeps claims and gallery fresh when fallback inbox fails independently', async () => {
    const claims = [{
      id: 'claim-a', attemptId: 'attempt-a', userId: 'user-a', status: 'pending' as const,
      expiresAt: '2026-08-28T08:10:00.000Z',
    }]
    const gallery = { media: [], nextCursor: null }
    const result = await loadCheckInExtras({
      claims: vi.fn().mockResolvedValue(claims),
      fallbacks: vi.fn().mockRejectedValue(new Error('fallback inbox unavailable')),
      gallery: vi.fn().mockResolvedValue(gallery),
    })

    expect(result).toEqual({ claims, gallery })
  })
})
