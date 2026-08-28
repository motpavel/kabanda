import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import type { KabandaProgress, RaidHistoryPage, RaidMetrics, RaidResult } from './types'

const key = (identityId: string, resourceId: string) => JSON.stringify([identityId, resourceId])

function validMetrics(value: unknown): value is RaidMetrics {
  if (!value || typeof value !== 'object') return false
  const metrics = value as Partial<RaidMetrics>
  return ['durationSeconds', 'distanceMeters', 'uniquePoints', 'photos'].every((field) => {
    const metric = metrics[field as keyof RaidMetrics]
    return typeof metric === 'number' && Number.isFinite(metric) && metric >= 0
  })
}

function validResult(value: unknown): value is RaidResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<RaidResult>
  return result.schemaVersion === 1 && Boolean(result.raid) &&
    typeof result.raid?.id === 'string' && typeof result.raid?.kabandaId === 'string' &&
    typeof result.raid?.title === 'string' && Number.isFinite(Date.parse(result.raid?.completedAt ?? '')) &&
    validMetrics(result.team) && validMetrics(result.personal) && Array.isArray(result.participants) &&
    result.participants.every((participant) =>
      participant && typeof participant.userId === 'string' &&
      typeof participant.displayName === 'string' && validMetrics(participant.metrics),
    )
}

function newestFirst(page: RaidHistoryPage): RaidHistoryPage {
  return {
    raids: [...page.raids]
      .filter((raid) =>
        typeof raid.raidId === 'string' &&
        typeof raid.title === 'string' &&
        Number.isFinite(Date.parse(raid.completedAt)) &&
        validMetrics(raid.team) &&
        validMetrics(raid.personal),
      )
      .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
      .slice(0, 20),
    nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null,
  }
}

function validProgress(value: unknown): value is KabandaProgress {
  if (!value || typeof value !== 'object') return false
  const progress = value as Partial<KabandaProgress>
  return validMetrics(progress.team) && validMetrics(progress.personal) &&
    typeof progress.team?.completedRaids === 'number' && progress.team.completedRaids >= 0 &&
    typeof progress.personal?.completedRaids === 'number' && progress.personal.completedRaids >= 0
}

async function identityMatches(identityId: string): Promise<boolean> {
  return (await getActiveIdentityId()) === identityId
}

export async function saveRaidResult(identityId: string, result: RaidResult): Promise<void> {
  if (!(await identityMatches(identityId)) || !validResult(result)) return
  await offlineDb.raidResults.put({
    key: key(identityId, result.raid.id), identityId, raidId: result.raid.id,
    kabandaId: result.raid.kabandaId, savedAt: new Date().toISOString(), result,
  })
}

export async function readRaidResult(identityId: string, raidId: string) {
  if (!(await identityMatches(identityId))) return null
  const record = await offlineDb.raidResults.get(key(identityId, raidId))
  if (!record || record.identityId !== identityId || !validResult(record.result)) return null
  return { result: record.result, savedAt: record.savedAt }
}

export async function saveRaidHistory(
  identityId: string,
  kabandaId: string,
  page: RaidHistoryPage,
): Promise<void> {
  if (!(await identityMatches(identityId))) return
  await offlineDb.raidHistory.put({
    key: key(identityId, kabandaId), identityId, kabandaId,
    savedAt: new Date().toISOString(), history: newestFirst(page),
  })
}

export async function readRaidHistory(identityId: string, kabandaId: string) {
  if (!(await identityMatches(identityId))) return null
  const record = await offlineDb.raidHistory.get(key(identityId, kabandaId))
  if (!record || record.identityId !== identityId || !record.history || typeof record.history !== 'object') return null
  const page = newestFirst(record.history as RaidHistoryPage)
  return { page, savedAt: record.savedAt }
}

export async function saveKabandaProgress(
  identityId: string,
  kabandaId: string,
  progress: KabandaProgress,
): Promise<void> {
  if (!(await identityMatches(identityId)) || !validProgress(progress)) return
  await offlineDb.kabandaProgress.put({
    key: key(identityId, kabandaId), identityId, kabandaId,
    savedAt: new Date().toISOString(), progress,
  })
}

export async function readKabandaProgress(identityId: string, kabandaId: string) {
  if (!(await identityMatches(identityId))) return null
  const record = await offlineDb.kabandaProgress.get(key(identityId, kabandaId))
  if (!record || record.identityId !== identityId || !validProgress(record.progress)) return null
  return { progress: record.progress, savedAt: record.savedAt }
}

export { newestFirst }
