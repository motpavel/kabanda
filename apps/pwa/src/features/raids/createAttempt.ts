import type { CreateRaidInput } from './types'

const storageKey = 'kabanda:create-raid-attempt:v1'

export interface CreateRaidAttempt {
  kabandaId: string
  normalizedPayload: string
  key: string
}

export interface RestoredCreateRaidForm {
  title: string
  description: string
  startMode: 'now' | 'later'
  startsAt: string
}

export function normalizeCreateRaidPayload(input: CreateRaidInput): string {
  return JSON.stringify({
    title: input.title,
    description: input.description,
    scheduledAt: input.scheduledAt,
  })
}

export function selectCreateRaidAttempt(
  previous: CreateRaidAttempt | null,
  kabandaId: string,
  normalizedPayload: string,
  freshKey: string,
): CreateRaidAttempt {
  if (matchesCreateRaidAttempt(previous, kabandaId, normalizedPayload)) {
    return previous
  }
  return { kabandaId, normalizedPayload, key: freshKey }
}

export function matchesCreateRaidAttempt(
  attempt: CreateRaidAttempt | null,
  kabandaId: string,
  normalizedPayload: string,
): attempt is CreateRaidAttempt {
  return attempt?.kabandaId === kabandaId && attempt.normalizedPayload === normalizedPayload
}

export function localDateTimeInputToIso(value: string): string | null {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function isoToLocalDateTimeInput(value: string): string | null {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return null
  const localTimestamp = date.getTime() - date.getTimezoneOffset() * 60_000
  return new Date(localTimestamp).toISOString().slice(0, 23)
}

export function restoreCreateRaidForm(
  attempt: CreateRaidAttempt | null,
  kabandaId: string,
): RestoredCreateRaidForm | null {
  if (!attempt || attempt.kabandaId !== kabandaId || !attempt.key) return null
  try {
    const value = JSON.parse(attempt.normalizedPayload) as Partial<CreateRaidInput>
    if (
      typeof value.title !== 'string' ||
      !value.title ||
      value.title.length > 100 ||
      (value.description !== null && typeof value.description !== 'string') ||
      (typeof value.description === 'string' && value.description.length > 500) ||
      (value.scheduledAt !== null && typeof value.scheduledAt !== 'string')
    ) return null

    const input: CreateRaidInput = {
      title: value.title,
      description: value.description ?? null,
      scheduledAt: value.scheduledAt ?? null,
    }
    if (normalizeCreateRaidPayload(input) !== attempt.normalizedPayload) return null
    if (input.scheduledAt === null) {
      return { title: input.title, description: input.description ?? '', startMode: 'now', startsAt: '' }
    }
    const startsAt = isoToLocalDateTimeInput(input.scheduledAt)
    if (!startsAt || localDateTimeInputToIso(startsAt) !== input.scheduledAt) return null
    return {
      title: input.title,
      description: input.description ?? '',
      startMode: 'later',
      startsAt,
    }
  } catch {
    return null
  }
}

function parseAttempt(raw: string | null): CreateRaidAttempt | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<CreateRaidAttempt>
    return typeof value.kabandaId === 'string' &&
      typeof value.normalizedPayload === 'string' &&
      typeof value.key === 'string' &&
      value.key.length > 0
      ? {
          kabandaId: value.kabandaId,
          normalizedPayload: value.normalizedPayload,
          key: value.key,
        }
      : null
  } catch {
    return null
  }
}

export function readCreateRaidAttempt(): CreateRaidAttempt | null {
  try {
    return parseAttempt(sessionStorage.getItem(storageKey))
  } catch {
    return null
  }
}

export function persistCreateRaidAttempt(attempt: CreateRaidAttempt): void {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(attempt))
  } catch {
    // The in-memory fallback in the form still keeps retries stable for this mount.
  }
}

export function clearCreateRaidAttempt(attempt: CreateRaidAttempt): void {
  try {
    if (parseAttempt(sessionStorage.getItem(storageKey))?.key === attempt.key) {
      sessionStorage.removeItem(storageKey)
    }
  } catch {
    // A canonical response is already received; unavailable storage needs no cleanup.
  }
}
