export type HistoryMapPoint = { id: string; latitude: number; longitude: number }
export type HistoryAnchor = Pick<HistoryMapPoint, 'latitude' | 'longitude'>
export const HISTORY_WARMUP_LIMIT = 3
export const HISTORY_WARMUP_DELAY = 1500

/** Only a few nearby summaries; never sweep a city catalogue or fetch photos. */
export function nearbyHistoryIds(points: readonly HistoryMapPoint[], anchor?: HistoryAnchor | null, priorityPointId?: string | null): string[] {
  const valid = points.filter(point => point.id && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180)
  const origin = anchor && Number.isFinite(anchor.latitude) && Number.isFinite(anchor.longitude) ? anchor : null
  const scale = origin ? Math.cos(origin.latitude * Math.PI / 180) : 1
  const distance = (point: HistoryMapPoint) => origin
    ? (point.latitude - origin.latitude) ** 2 + ((point.longitude - origin.longitude) * scale) ** 2 : 0
  const ordered = origin ? [...valid].sort((a, b) => distance(a) - distance(b)) : []
  const priority = valid.find(point => point.id === priorityPointId)
  return [...new Set([...(priority ? [priority.id] : []), ...ordered.map(point => point.id)])].slice(0, HISTORY_WARMUP_LIMIT)
}

type Connection = { saveData?: boolean; effectiveType?: string; downlink?: number }
export function canWarmHistory(online: boolean, visible: boolean, connection?: Connection): boolean {
  return online && visible && !connection?.saveData && !/^(slow-2g|2g|3g)$/.test(connection?.effectiveType ?? '') &&
    !(typeof connection?.downlink === 'number' && connection.downlink < 1)
}

/** All map consumers share one lane. Obsolete queued work is dropped before
 * starting; an in-flight resource stays shared with a newly opened sheet. */
export function createHistoryWarmupQueue() {
  let tail = Promise.resolve()
  return (allowed: () => boolean, read: () => Promise<void>): Promise<void> => {
    const task = tail.then(async () => { if (allowed()) await read() }).catch(() => undefined)
    tail = task
    return task
  }
}
