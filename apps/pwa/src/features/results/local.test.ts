import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../checkins/replay', () => ({
  replayOneCheckInOrMedia: vi.fn(),
  replayOneIssuedMedia: vi.fn(),
}))

import { replayOneIssuedMedia } from '../checkins/replay'
import { drainFinalizingServerTail } from './local'

describe('finalizing foreground drain', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('continues in bounded chunks instead of treating ten media as idle', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => 'tab-a',
      setItem: () => undefined,
    })
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
  })
})
