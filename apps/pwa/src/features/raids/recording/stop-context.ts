import type { NearbyPoint, OneShotCoordinate } from '../../checkins/types'
import { riderDistanceMeters } from './rider-markers'

export type StopPoint = NearbyPoint & { lastAttemptId?: string | null }
export type StopContext = { point: StopPoint; outsideSince: number | null; lastOutsideFix: string | null }

/** Selection memory only. It is never used as fresh evidence or presence. */
export function retainStop(
  current: StopContext | null,
  candidate: StopPoint | null,
  coordinate: OneShotCoordinate | null,
  now: number,
  explicitlySelected = false,
): StopContext | null {
  if (!current || (explicitlySelected && candidate?.pointSnapshotId !== current.point.pointSnapshotId)) {
    return candidate ? { point: candidate, outsideSince: null, lastOutsideFix: null } : null
  }
  const age = coordinate ? now - Date.parse(coordinate.capturedAt) : Infinity
  if (!coordinate || age < -5000 || age > 10_000 || coordinate.accuracyMeters > 50) return current
  const far = riderDistanceMeters(coordinate, { ...current.point, capturedAt: coordinate.capturedAt }) > 100
  if (!far) return {
    point: candidate?.pointSnapshotId === current.point.pointSnapshotId ? candidate : current.point,
    outsideSince: null, lastOutsideFix: null,
  }
  if (coordinate.capturedAt === current.lastOutsideFix) return current
  const capturedAt = Date.parse(coordinate.capturedAt)
  if (current.outsideSince !== null && capturedAt - current.outsideSince >= 8000) {
    return candidate ? { point: candidate, outsideSince: null, lastOutsideFix: null } : null
  }
  return { ...current, outsideSince: current.outsideSince ?? capturedAt, lastOutsideFix: coordinate.capturedAt }
}
