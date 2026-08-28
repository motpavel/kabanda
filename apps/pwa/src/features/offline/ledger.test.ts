import { describe, expect, it } from 'vitest'
import { canReplayOperation } from './ledger'
import type { OutboxOperation } from './types'

const operation: OutboxOperation = {
  id: 'operation-1',
  identityId: 'user-a',
  kind: 'route.sample',
  aggregateId: 'raid-1',
  payload: {},
  createdAt: '2026-08-28T05:00:00.000Z',
  status: 'pending',
  attempts: 0,
}

describe('identity-bound outbox', () => {
  it('replays an operation only for the active identity', () => {
    expect(canReplayOperation(operation, 'user-a')).toBe(true)
    expect(canReplayOperation(operation, 'user-b')).toBe(false)
  })

  it('does not select an operation already being sent', () => {
    expect(canReplayOperation({ ...operation, status: 'sending' }, 'user-a')).toBe(false)
  })
})
