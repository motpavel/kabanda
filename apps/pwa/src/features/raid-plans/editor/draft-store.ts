import type { RaidTemplateDraft } from '../types'

const DRAFT_PREFIX = 'kabanda.raid-template-draft.v1'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function createRaidTemplateDraft(identityId: string, kabandaId: string, now = new Date().toISOString()): RaidTemplateDraft {
  return {
    schemaVersion: 1,
    clientDraftId: randomId(),
    identityId,
    kabandaId,
    title: '',
    coverImage: null,
    points: [],
    selectedPointId: null,
    idempotencyKey: randomId(),
    updatedAt: now,
  }
}

export function readRaidTemplateDraft(
  identityId: string,
  kabandaId: string,
  storage = browserStorage(),
): RaidTemplateDraft | null {
  if (!storage) return null
  try {
    const value: unknown = JSON.parse(storage.getItem(draftKey(identityId, kabandaId)) ?? 'null')
    return parseDraft(value, identityId, kabandaId)
  } catch {
    return null
  }
}

export function saveRaidTemplateDraft(draft: RaidTemplateDraft, storage = browserStorage()): boolean {
  if (!storage) return false
  try {
    storage.setItem(draftKey(draft.identityId, draft.kabandaId), JSON.stringify(draft))
    return true
  } catch {
    return false
  }
}

export function clearRaidTemplateDraft(identityId: string, kabandaId: string, storage = browserStorage()): void {
  try {
    storage?.removeItem(draftKey(identityId, kabandaId))
  } catch {
    // A failed cleanup must not turn a successful canonical save into an error.
  }
}

export function draftKey(identityId: string, kabandaId: string): string {
  return `${DRAFT_PREFIX}:${identityId}:${kabandaId}`
}

function parseDraft(value: unknown, identityId: string, kabandaId: string): RaidTemplateDraft | null {
  if (!value || typeof value !== 'object') return null
  const draft = value as Partial<RaidTemplateDraft>
  const valid = draft.schemaVersion === 1 &&
    draft.identityId === identityId &&
    draft.kabandaId === kabandaId &&
    typeof draft.clientDraftId === 'string' &&
    typeof draft.idempotencyKey === 'string' &&
    typeof draft.title === 'string' &&
    (draft.coverImage === null || typeof draft.coverImage === 'string') &&
    Array.isArray(draft.points) &&
    draft.points.length <= 10 &&
    draft.points.every(isDraftPoint) &&
    (draft.selectedPointId === null || typeof draft.selectedPointId === 'string') &&
    typeof draft.updatedAt === 'string'
  if (!valid) return null
  return {
    schemaVersion: 1,
    clientDraftId: draft.clientDraftId!,
    identityId,
    kabandaId,
    title: draft.title!,
    coverImage: draft.coverImage!,
    points: draft.points!,
    selectedPointId: draft.selectedPointId!,
    idempotencyKey: draft.idempotencyKey!,
    updatedAt: draft.updatedAt!,
  }
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isDraftPoint(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const point = value as Record<string, unknown>
  return typeof point.clientId === 'string' &&
    typeof point.name === 'string' &&
    typeof point.address === 'string' &&
    typeof point.comment === 'string' &&
    typeof point.latitude === 'number' && Number.isFinite(point.latitude) &&
    typeof point.longitude === 'number' && Number.isFinite(point.longitude) &&
    (point.geocodeStatus === 'pending' || point.geocodeStatus === 'ready' || point.geocodeStatus === 'failed') &&
    (point.geocodeRequestId === null || typeof point.geocodeRequestId === 'string') &&
    typeof point.labelsConfirmed === 'boolean'
}
