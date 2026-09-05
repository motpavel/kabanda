import { describe, expect, it } from 'vitest'
import { buildReadinessReport, buildReadinessRows } from './state'
import type { LocalReadinessFacts } from './types'

const facts: LocalReadinessFacts = {
  appMode: 'standalone',
  locationPermission: 'granted',
  coordinateMeasuredAt: '2026-08-28T08:00:20.000Z',
  accuracyM: 17.8,
  indexedDbWritable: true,
  storageAvailable: true,
  online: true,
  measuredAt: '2026-08-28T08:00:22.000Z',
  serviceWorkerControlled: true,
  wakeLockSupported: true,
}

describe('navigator readiness', () => {
  it('keeps Wake Lock as warning and never claims background GPS pass', () => {
    const rows = buildReadinessRows(facts, Date.parse('2026-08-28T08:00:22.000Z'))
    expect(rows.find(({ id }) => id === 'location')?.status).toBe('pass')
    expect(rows.find(({ id }) => id === 'wake-lock')).toMatchObject({ status: 'warn' })
    expect(rows.find(({ id }) => id === 'wake-lock')?.detail).toContain('запись в фоне может прерваться')
  })

  it('fails denied location and offline start without inventing a coordinate', () => {
    const rows = buildReadinessRows(
      {
        ...facts,
        locationPermission: 'denied',
        coordinateMeasuredAt: null,
        accuracyM: null,
        online: false,
      },
      Date.parse('2026-08-28T08:00:22.000Z'),
    )
    expect(rows.find(({ id }) => id === 'location')?.status).toBe('fail')
    expect(rows.find(({ id }) => id === 'network')).toMatchObject({
      status: 'fail',
      detail: 'Для старта подключитесь к интернету',
    })
  })

  it('keeps unsupported storage estimation unknown and measured failure blocking', () => {
    const unsupported = buildReadinessRows(
      { ...facts, storageAvailable: null },
      Date.parse('2026-08-28T08:00:22.000Z'),
    )
    const failed = buildReadinessRows(
      { ...facts, storageAvailable: false },
      Date.parse('2026-08-28T08:00:22.000Z'),
    )
    expect(unsupported.find(({ id }) => id === 'storage')?.status).toBe('unknown')
    expect(failed.find(({ id }) => id === 'storage')?.status).toBe('fail')
    expect(buildReadinessReport(7, { ...facts, storageAvailable: null }).storageAvailable).toBeNull()
  })

  it('sends only the approved measured readiness fields', () => {
    expect(buildReadinessReport(7, facts)).toEqual({
      expectedVersion: 7,
      appMode: 'standalone',
      locationPermission: 'granted',
      coordinateMeasuredAt: '2026-08-28T08:00:20.000Z',
      accuracyM: 17.8,
      indexedDbWritable: true,
      storageAvailable: true,
      online: true,
      measuredAt: '2026-08-28T08:00:22.000Z',
    })
  })
})
