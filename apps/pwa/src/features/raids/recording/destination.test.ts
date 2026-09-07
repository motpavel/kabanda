import { describe, expect, it } from 'vitest'
import type { RaidDestination } from '@kabanda/contracts'
import type { NearbyPoint } from '../../checkins/types'
import { destinationKey, selectArrivalPoint } from './destination'

const target: RaidDestination = { pointSnapshotId: 'target', sourcePointId: 'source', name: 'Цель', latitude: 56.86, longitude: 53.21, selectedAt: '2026-09-07T12:00:00Z' }
const nearby: NearbyPoint = { ...target, distanceMeters: 20, creditedByMe: false, creditedByTeam: false }
const defaults = { nearby: [nearby], planned: false, destination: target, handledDestination: '', selectedPointId: null, repeatPointId: null }

describe('shared destination arrival', () => {
  it('waits for the chosen destination instead of opening an unrelated nearby point', () => {
    expect(selectArrivalPoint({ ...defaults, nearby: [{ ...nearby, pointSnapshotId: 'other' }] })).toBeNull()
  })
  it('opens the target at arrival and permits a deliberate free-hunt repeat', () => {
    expect(selectArrivalPoint(defaults)?.pointSnapshotId).toBe('target')
    expect(selectArrivalPoint({ ...defaults, nearby: [{ ...nearby, creditedByMe: true }] })?.pointSnapshotId).toBe('target')
    expect(selectArrivalPoint({ ...defaults, planned: true, nearby: [{ ...nearby, creditedByMe: true }] })).toBeNull()
  })
  it('does not reopen after local save, but a later selection of the same point is new', () => {
    const handledDestination = destinationKey(target)
    expect(selectArrivalPoint({ ...defaults, handledDestination })).toBeNull()
    expect(selectArrivalPoint({ ...defaults, handledDestination, destination: { ...target, selectedAt: '2026-09-07T13:00:00Z' } })?.pointSnapshotId).toBe('target')
  })
  it('allows explicit inspection of another nearby point and retains ordinary arrivals without a target', () => {
    const other = { ...nearby, pointSnapshotId: 'other' }
    expect(selectArrivalPoint({ ...defaults, nearby: [other], selectedPointId: 'other' })).toBe(other)
    expect(selectArrivalPoint({ ...defaults, destination: null })).toBe(nearby)
    expect(selectArrivalPoint({ ...defaults, nearby: [] })).toBeNull()
  })
})
