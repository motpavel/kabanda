import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RaidProjection } from '../raids/types'
import { canCompleteRaid, completeReadyRaid } from './complete'
import { settleFinalization } from './api'
import { saveRaidResult } from './cache'
vi.mock('./api', () => ({ settleFinalization: vi.fn() }))
vi.mock('./cache', () => ({ saveRaidResult: vi.fn() }))
const raid = (overrides: Partial<RaidProjection> = {}): RaidProjection => ({
  id: 'raid', kabandaId: 'team', title: 'Поездка', state: 'finalizing', version: 4,
  scheduledAt: null, description: null, organizerUserId: 'me', navigatorUserId: 'me',
  navigatorReady: false, navigatorBlockers: [], navigatorWarnings: [], participants: [],
  routeStatus: { status: 'stopped', lastSampleAt: null, lastReceivedAt: null, acceptedSampleCount: 0, missingSequenceCount: 0 },
  navigatorLease: null, allowedActions: ['settle-finalization'],
  finalization: { status: 'collecting', partial: false, pendingCounts: { claims: 0, fallbacks: 0, media: 0 }, deadlineAt: new Date(Date.now()+120000).toISOString(), canSettle: true },
  ...overrides,
})
beforeEach(() => {
  vi.clearAllMocks()
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  vi.mocked(saveRaidResult).mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())
describe('automatic completion after finish confirmation', () => {
  it('saves a ready final result without another user command', async () => {
    const completed = raid({ state: 'completed' })
    vi.mocked(settleFinalization).mockResolvedValue({ raid: completed, result: {} as never })
    expect(await completeReadyRaid('me', raid())).toBe(completed)
    expect(settleFinalization).toHaveBeenCalledOnce()
  })
  it('does not close the upload window while photos are pending or settle as a participant', async () => {
    const pending = raid()
    pending.finalization!.pendingCounts.media = 1
    expect(await completeReadyRaid('me', pending)).toBe(pending)
    expect(canCompleteRaid(raid({ allowedActions: [] }))).toBe(false)
    expect(settleFinalization).not.toHaveBeenCalled()
    pending.finalization!.deadlineAt = new Date(Date.now()-1).toISOString()
    expect(canCompleteRaid(pending)).toBe(true)
  })
  it('reuses the saved operation key after a lost response and remount', async () => {
    const current = raid()
    vi.mocked(settleFinalization).mockRejectedValueOnce(new TypeError('Lost response')).mockResolvedValueOnce({ raid: raid({ state: 'completed' }), result: {} as never })
    await expect(completeReadyRaid('me', current)).rejects.toThrow()
    await completeReadyRaid('me', current)
    expect(vi.mocked(settleFinalization).mock.calls[1]).toEqual(vi.mocked(settleFinalization).mock.calls[0])
  })
  it('shows the confirmed server result even if the local cache is full', async () => {
    const completed = raid({ state: 'completed' })
    vi.mocked(settleFinalization).mockResolvedValue({ raid: completed, result: {} as never })
    vi.mocked(saveRaidResult).mockRejectedValue(new Error('Storage full'))
    expect(await completeReadyRaid('me', raid())).toBe(completed)
  })
})
