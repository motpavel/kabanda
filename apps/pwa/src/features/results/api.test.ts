import { afterEach, describe, expect, it, vi } from 'vitest'
import { finishRaid } from './api'

describe('finish API contract', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends bounded needsAction inside the immutable inventory', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ raid: {}, finalization: {} }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await finishRaid('raid-a', 8, {
      routePending: 0,
      checkInsPending: 0,
      mediaPending: 0,
      needsAction: 2,
    }, true, 'finish-key')

    expect(fetchMock).toHaveBeenCalledWith('/api/raids/raid-a/commands/finish', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'Idempotency-Key': 'finish-key' }),
      body: JSON.stringify({
        expectedVersion: 8,
        inventory: { routePending: 0, checkInsPending: 0, mediaPending: 0, needsAction: 2 },
        confirmPartial: true,
      }),
    }))
  })
})
