import type { RaidDestination } from '@kabanda/contracts'
import type { NearbyPoint } from '../../checkins/types'

export const destinationKey = (destination: RaidDestination | null | undefined) => destination
  ? `${destination.pointSnapshotId}:${destination.selectedAt}` : ''

export function selectArrivalPoint({ nearby, planned, destination, handledDestination, selectedPointId, repeatPointId }: {
  nearby: readonly NearbyPoint[]
  planned: boolean
  destination: RaidDestination | null | undefined
  handledDestination: string
  selectedPointId: string | null
  repeatPointId: string | null
}): NearbyPoint | null {
  const selected = nearby.find((point) => point.pointSnapshotId === selectedPointId &&
    (!point.creditedByMe || (!planned && point.pointSnapshotId === repeatPointId)))
  if (selected) return selected
  if (destination) {
    if (handledDestination === destinationKey(destination)) return null
    return nearby.find((point) => point.pointSnapshotId === destination.pointSnapshotId && (!planned || !point.creditedByMe)) ?? null
  }
  return nearby.find((point) => !point.creditedByMe) ?? null
}
