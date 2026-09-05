import { describe, expect, it } from 'vitest'
import {
  canShareRaidInvite,
  isReadinessReportCurrent,
  isStaleConflict,
  selectCurrentRaid,
  selectPrimaryAction,
} from './state'
import type { RaidProjection } from './types'

const raid: RaidProjection = {
  id: '11111111-1111-4111-8111-111111111111',
  kabandaId: '22222222-2222-4222-8222-222222222222',
  title: 'Вечерний рейд',
  state: 'lobby',
  version: 4,
  scheduledAt: null,
  description: null,
  organizerUserId: 'user-owner',
  navigatorUserId: 'user-owner',
  navigatorReady: false,
  navigatorBlockers: [],
  navigatorWarnings: [],
  routeStatus: {
    status: 'awaiting_lease',
    lastSampleAt: null,
    lastReceivedAt: null,
    acceptedSampleCount: 0,
    missingSequenceCount: 0,
  },
  navigatorLease: null,
  finalization: null,
  participants: [],
  allowedActions: [],
}

describe('raid primary CTA', () => {
  it('shares the locator only after open-lobby creates the participant snapshot', () => {
    expect(canShareRaidInvite('draft')).toBe(false)
    expect(canShareRaidInvite('planned')).toBe(false)
    expect(canShareRaidInvite('lobby')).toBe(true)
    expect(canShareRaidInvite('active')).toBe(false)
  })

  it('uses one state-specific home action', () => {
    const cases: Array<[RaidProjection['state'], string | null]> = [
      ['draft', 'Продолжить настройку'],
      ['planned', 'Открыть рейд'],
      ['lobby', 'Открыть сбор'],
      ['active', 'Вернуться в рейд'],
      ['paused', 'Вернуться в рейд'],
      ['finalizing', 'Проверить завершение'],
      ['completed', 'Открыть итог'],
      ['cancelled', null],
    ]
    for (const [state, label] of cases) {
      expect(
        selectPrimaryAction(
          { ...raid, state },
          { surface: 'home', online: true, stale: false },
        )?.label ?? null,
      ).toBe(label)
    }
  })

  it('derives commands only from server allowedActions', () => {
    expect(
      selectPrimaryAction(raid, { surface: 'raid', online: true, stale: false }),
    ).toBeNull()
    expect(
      selectPrimaryAction(
        { ...raid, allowedActions: ['accept', 'decline'] },
        { surface: 'raid', online: true, stale: false },
      ),
    ).toEqual({ kind: 'command', command: 'accept', label: 'Принять приглашение' })
    expect(
      selectPrimaryAction(
        { ...raid, allowedActions: ['start'] },
        { surface: 'raid', online: false, stale: false },
      ),
    ).toBeNull()
  })

  it('keeps the explicit phone-readiness step only for the selected navigator', () => {
    const acceptedNavigator = selectPrimaryAction(
      { ...raid, allowedActions: ['ready'] },
      {
        surface: 'raid',
        online: true,
        stale: false,
        viewerIsNavigator: true,
        viewerParticipantState: 'accepted',
        localReadinessReported: false,
      },
    )
    const acceptedMember = selectPrimaryAction(
      { ...raid, navigatorUserId: 'someone-else', allowedActions: ['ready'] },
      {
        surface: 'raid',
        online: true,
        stale: false,
        viewerIsNavigator: false,
        viewerParticipantState: 'accepted',
      },
    )
    expect(acceptedNavigator).toEqual({ kind: 'command', command: 'ready', label: 'Я готов' })
    expect(acceptedMember).toBeNull()
  })

  it('checks the selected navigator device only after participant ready', () => {
    expect(
      selectPrimaryAction(
        { ...raid, allowedActions: [] },
        {
          surface: 'raid',
          online: true,
          stale: false,
          viewerIsNavigator: true,
          viewerParticipantState: 'ready',
          localReadinessReported: false,
        },
      ),
    ).toEqual({ kind: 'readiness', label: 'Проверить телефон' })
  })

  it('shows canonical start after reload when server navigatorReady is true', () => {
    expect(
      selectPrimaryAction(
        { ...raid, allowedActions: ['ready', 'start'], navigatorReady: true },
        {
          surface: 'raid',
          online: true,
          stale: false,
          viewerIsNavigator: true,
          viewerParticipantState: 'ready',
          localReadinessReported: false,
        },
      ),
    ).toEqual({ kind: 'command', command: 'start', label: 'Начать рейд' })
  })

  it('rejects a readiness report from the previous raid version', () => {
    const report = {
      status: 'pass' as const,
      blockers: [],
      expiresAt: '2026-08-28T09:05:00.000Z',
      raidVersion: 7,
    }
    const now = Date.parse('2026-08-28T09:00:00.000Z')
    expect(isReadinessReportCurrent(report, 7, now)).toBe(true)
    expect(isReadinessReportCurrent(report, 8, now)).toBe(false)
    expect(isReadinessReportCurrent({ ...report, blockers: ['LOCATION_STALE'] }, 7, now)).toBe(false)
    expect(isReadinessReportCurrent({ ...report, expiresAt: '2026-08-28T09:00:00.000Z' }, 7, now)).toBe(false)
  })

  it('never mutates a stale projection and refreshes only when online', () => {
    expect(
      selectPrimaryAction(
        { ...raid, allowedActions: ['start'] },
        { surface: 'raid', online: true, stale: true },
      ),
    ).toEqual({ kind: 'refresh', label: 'Обновить данные' })
    expect(
      selectPrimaryAction(
        { ...raid, allowedActions: ['start'] },
        { surface: 'raid', online: false, stale: true },
      ),
    ).toBeNull()
  })
})

describe('stale command conflict', () => {
  it('refreshes version conflicts but not unrelated domain conflicts', () => {
    expect(isStaleConflict(409, 'RAID_VERSION_CONFLICT')).toBe(true)
    expect(isStaleConflict(409, 'VERSION_CONFLICT')).toBe(true)
    expect(isStaleConflict(409, 'STALE_VERSION')).toBe(true)
    expect(isStaleConflict(409, 'INVALID_TRANSITION')).toBe(false)
    expect(isStaleConflict(400, 'VERSION_CONFLICT')).toBe(false)
  })
})

describe('per-Kabanda actionable raids', () => {
  it('selects current only from the supplied Kabanda list', () => {
    const planned = { ...raid, id: 'planned', state: 'planned' as const }
    const active = { ...raid, id: 'active', state: 'active' as const }
    expect(selectCurrentRaid([planned, active])).toBe(active)
    expect(selectCurrentRaid([planned])).toBeNull()
  })
})
