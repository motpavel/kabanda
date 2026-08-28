import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import type { PointCollectionProjection } from '../offline/types'
import type { KabandaPoint } from './types'

function projectionKey(identityId: string, kabandaId: string, collectionId: string): string {
  return JSON.stringify([identityId, kabandaId, collectionId])
}

function isPoint(value: unknown): value is KabandaPoint {
  if (!value || typeof value !== 'object') return false
  const point = value as Partial<KabandaPoint>
  return (
    typeof point.id === 'string' &&
    typeof point.stableId === 'string' &&
    typeof point.name === 'string' &&
    typeof point.latitude === 'number' &&
    typeof point.longitude === 'number' &&
    (point.verificationStatus === 'source_checked' ||
      point.verificationStatus === 'field_verified' ||
      point.verificationStatus === 'rejected') &&
    typeof point.visitedByMe === 'boolean' &&
    typeof point.visitedByTeam === 'boolean'
  )
}

export async function savePointProjection(
  identityId: string,
  kabandaId: string,
  collectionId: string,
  points: KabandaPoint[],
): Promise<void> {
  if ((await getActiveIdentityId()) !== identityId) return
  const projection: PointCollectionProjection = {
    key: projectionKey(identityId, kabandaId, collectionId),
    identityId,
    kabandaId,
    collectionId,
    savedAt: new Date().toISOString(),
    points,
  }
  await offlineDb.pointCollections.put(projection)
}

export async function readPointProjection(
  identityId: string,
  kabandaId: string,
  collectionId: string,
): Promise<{ points: KabandaPoint[]; savedAt: string } | null> {
  if ((await getActiveIdentityId()) !== identityId) return null
  const projection = await offlineDb.pointCollections.get(
    projectionKey(identityId, kabandaId, collectionId),
  )
  if (
    !projection ||
    projection.identityId !== identityId ||
    projection.kabandaId !== kabandaId ||
    projection.collectionId !== collectionId ||
    !projection.points.every(isPoint)
  ) {
    return null
  }
  return { points: projection.points, savedAt: projection.savedAt }
}
