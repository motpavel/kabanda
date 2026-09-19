import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../checkins/replay', () => ({
  replayOneCheckInOrMedia: vi.fn(),
  replayOneIssuedMedia: vi.fn(),
}))
vi.mock('../raids/field-outbox', () => ({
  pumpFieldOperations: vi.fn(),
  fieldInventory: vi.fn(),
}))

import { replayOneIssuedMedia } from '../checkins/replay'
import { pumpFieldOperations } from '../raids/field-outbox'
import { drainFinalizingServerTail } from './local'

// Queue persistence and identity fences have their own IndexedDB tests.
// This unit tests coordination and chunk boundaries, without opening a database.
describe('finalizing foreground drain', () => {
  beforeEach(() => {
    vi.mocked(replayOneIssuedMedia).mockReset()
    vi.mocked(pumpFieldOperations).mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('sessionStorage', {
      getItem: () => 'tab-a',
      setItem: () => undefined,
    })
  })
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('continues in bounded chunks instead of treating ten media as idle', async () => {
    const replay = vi.mocked(replayOneIssuedMedia)
    for (let index = 0; index < 11; index += 1) {
      replay.mockResolvedValueOnce({ kind: 'media', operationId: `operation-${index}`, mediaId: `media-${index}` })
    }
    replay.mockResolvedValueOnce({ kind: 'idle' })

    await expect(drainFinalizingServerTail({
      identityId: 'user-a', raidId: 'raid-a', online: true, maxOperations: 10,
    })).resolves.toEqual({ processed: 10, mayHaveMore: true })
    await expect(drainFinalizingServerTail({
      identityId: 'user-a', raidId: 'raid-a', online: true, maxOperations: 10,
    })).resolves.toEqual({ processed: 1, mayHaveMore: false })
    expect(replay).toHaveBeenCalledTimes(12)
    expect(pumpFieldOperations).toHaveBeenCalledTimes(4)
    expect(pumpFieldOperations).toHaveBeenCalledWith('user-a', 'raid-a', 'team')
    expect(pumpFieldOperations).toHaveBeenCalledWith('user-a', 'raid-a', 'materials')
  })

  it('does not report a drained tail when a new durable lane cannot be read', async () => {
    vi.mocked(pumpFieldOperations).mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(drainFinalizingServerTail({ identityId: 'user-a', raidId: 'raid-a', online: true }))
      .rejects.toThrow('Storage unavailable')
    expect(replayOneIssuedMedia).not.toHaveBeenCalled()
  })

  it('does not start any network lane while offline', async () => {
    await expect(drainFinalizingServerTail({ identityId: 'user-a', raidId: 'raid-a', online: false }))
      .resolves.toEqual({ processed: 0, mayHaveMore: false })
    expect(pumpFieldOperations).not.toHaveBeenCalled()
    expect(replayOneIssuedMedia).not.toHaveBeenCalled()
  })
})
