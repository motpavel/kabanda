import { describe, expect, it } from 'vitest'
import {
  localDateTimeInputToIso,
  normalizeCreateRaidPayload,
  restoreCreateRaidForm,
  selectCreateRaidAttempt,
} from './createAttempt'

const payload = normalizeCreateRaidPayload({
  title: 'Вечерний рейд',
  description: null,
  scheduledAt: '2026-08-28T16:00:00.000Z',
})

describe('create raid attempt', () => {
  it('reuses the persisted key for the same Kabanda and normalized payload', () => {
    const previous = { kabandaId: 'kabanda-1', normalizedPayload: payload, key: 'stable-key' }
    expect(selectCreateRaidAttempt(previous, 'kabanda-1', payload, 'new-key')).toBe(previous)
  })

  it('rotates the key when payload or Kabanda changes', () => {
    const previous = { kabandaId: 'kabanda-1', normalizedPayload: payload, key: 'stable-key' }
    expect(selectCreateRaidAttempt(previous, 'kabanda-1', `${payload} changed`, 'payload-key').key).toBe('payload-key')
    expect(selectCreateRaidAttempt(previous, 'kabanda-2', payload, 'kabanda-key').key).toBe('kabanda-key')
  })

  it('restores a scheduled form without changing its normalized ISO payload', () => {
    const attempt = { kabandaId: 'kabanda-1', normalizedPayload: payload, key: 'stable-key' }
    const restored = restoreCreateRaidForm(attempt, 'kabanda-1')
    expect(restored).toMatchObject({
      title: 'Вечерний рейд',
      description: '',
      startMode: 'later',
    })
    expect(restored).not.toBeNull()
    const scheduledAt = localDateTimeInputToIso(restored!.startsAt)
    expect(scheduledAt).toBe('2026-08-28T16:00:00.000Z')
    expect(normalizeCreateRaidPayload({
      title: restored!.title,
      description: restored!.description || null,
      scheduledAt,
    })).toBe(payload)
  })

  it('ignores a record for another Kabanda or an invalid normalized payload', () => {
    const attempt = { kabandaId: 'kabanda-1', normalizedPayload: payload, key: 'stable-key' }
    expect(restoreCreateRaidForm(attempt, 'kabanda-2')).toBeNull()
    expect(restoreCreateRaidForm({ ...attempt, normalizedPayload: '{broken' }, 'kabanda-1')).toBeNull()
    expect(restoreCreateRaidForm({ ...attempt, normalizedPayload: JSON.stringify({ title: '', description: null, scheduledAt: null }) }, 'kabanda-1')).toBeNull()
  })
})
