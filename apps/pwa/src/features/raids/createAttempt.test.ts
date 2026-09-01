import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearCreateRaidAttempt,
  localDateTimeInputToIso,
  normalizeCreateRaidPayload,
  persistCreateRaidAttempt,
  readCreateRaidAttempt,
  restoreCreateRaidForm,
  selectCreateRaidAttempt,
} from './createAttempt'

const payload = normalizeCreateRaidPayload({
  title: 'Вечерний рейд',
  description: null,
  scheduledAt: '2026-08-28T16:00:00.000Z',
})

describe('create raid attempt', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reuses the persisted key for the same Kabanda and normalized payload', () => {
    const previous = { identityId: 'user-a', kabandaId: 'kabanda-1', normalizedPayload: payload, key: 'stable-key' }
    expect(selectCreateRaidAttempt(previous, 'user-a', 'kabanda-1', payload, 'new-key')).toBe(previous)
  })

  it('rotates the key when identity, payload or Kabanda changes', () => {
    const previous = { identityId: 'user-a', kabandaId: 'kabanda-1', normalizedPayload: payload, key: 'stable-key' }
    expect(selectCreateRaidAttempt(previous, 'user-a', 'kabanda-1', `${payload} changed`, 'payload-key').key).toBe('payload-key')
    expect(selectCreateRaidAttempt(previous, 'user-a', 'kabanda-2', payload, 'kabanda-key').key).toBe('kabanda-key')
    expect(selectCreateRaidAttempt(previous, 'user-b', 'kabanda-1', payload, 'identity-key').key).toBe('identity-key')
  })

  it('restores a scheduled form without changing its normalized ISO payload', () => {
    const attempt = { identityId: 'user-a', kabandaId: 'kabanda-1', normalizedPayload: payload, key: 'stable-key' }
    const restored = restoreCreateRaidForm(attempt, 'user-a', 'kabanda-1')
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
    const attempt = { identityId: 'user-a', kabandaId: 'kabanda-1', normalizedPayload: payload, key: 'stable-key' }
    expect(restoreCreateRaidForm(attempt, 'user-b', 'kabanda-1')).toBeNull()
    expect(restoreCreateRaidForm(attempt, 'user-a', 'kabanda-2')).toBeNull()
    expect(restoreCreateRaidForm({ ...attempt, normalizedPayload: '{broken' }, 'user-a', 'kabanda-1')).toBeNull()
    expect(restoreCreateRaidForm({ ...attempt, normalizedPayload: JSON.stringify({ title: '', description: null, scheduledAt: null }) }, 'user-a', 'kabanda-1')).toBeNull()
  })

  it('does not restore another account draft and deletes the unbound legacy value', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    const attempt = { identityId: 'user-a', kabandaId: 'kabanda-1', normalizedPayload: payload, key: 'stable-key' }
    values.set('kabanda:create-raid-attempt:v1', JSON.stringify({ kabandaId: attempt.kabandaId, normalizedPayload: payload, key: 'legacy-key' }))

    persistCreateRaidAttempt('user-a', attempt)

    expect(readCreateRaidAttempt('user-a')).toEqual(attempt)
    expect(readCreateRaidAttempt('user-b')).toBeNull()
    expect(values.has('kabanda:create-raid-attempt:v1')).toBe(false)
    clearCreateRaidAttempt('user-b', attempt)
    expect(readCreateRaidAttempt('user-a')).toEqual(attempt)
    clearCreateRaidAttempt('user-a', attempt)
    expect(readCreateRaidAttempt('user-a')).toBeNull()
  })
})
