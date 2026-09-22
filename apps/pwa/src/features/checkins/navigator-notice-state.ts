type ConfirmedPoint = {
  id: string
  visitedByMe: boolean
  lastAttemptId?: string | null
  myLastVisitAttemptId?: string | null
  lastVisitParticipantIds?: readonly string[]
  lastVisitedAt?: string | null
}
type StoragePort = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }
const LIMIT = 256
const receiptKey = (point: ConfirmedPoint) => JSON.stringify([point.id, point.myLastVisitAttemptId])

/** Presentation-only receipts, kept separately from every outbox/cache. The
 * first real snapshot is a baseline, never a reason to replay celebrations.
 * Reordered reads, retries, remount and reload do not reannounce a seen visit.
 * Storage denial falls back to the current instance; it must never fail a visit. */
export class NavigatorNoticeState {
  private initialized = false
  private readonly seen = new Set<string>()
  private readonly key: string
  constructor(private readonly identityId: string, raidId: string, private readonly storage?: StoragePort) {
    this.key = `kabanda:navigator-notices:v1:${JSON.stringify([identityId, raidId])}`
    try {
      const raw = storage?.getItem(this.key)
      if (raw && raw.length <= 100_000) {
        const values: unknown = JSON.parse(raw)
        if (Array.isArray(values)) for (const value of values.slice(-LIMIT)) {
          if (typeof value === 'string' && value.length <= 300) this.seen.add(value)
        }
      }
    } catch { /* A toast is not worth interrupting recording or a saved command. */ }
  }

  /** Reauthorization/role changes establish a new baseline, not new visits. */
  suspend() { this.initialized = false }

  observe<T extends ConfirmedPoint>(points: readonly T[] | undefined): T | null {
    if (!points) return null
    const confirmed = points.filter(point => point.visitedByMe === true && Boolean(point.myLastVisitAttemptId) &&
      point.myLastVisitAttemptId === point.lastAttemptId && point.lastVisitParticipantIds?.includes(this.identityId))
    const fresh = this.initialized ? confirmed.filter(point => !this.seen.has(receiptKey(point))) : []
    this.initialized = true
    let changed = false
    for (const point of confirmed) {
      const key = receiptKey(point)
      if (!this.seen.has(key)) { this.seen.add(key); changed = true }
    }
    while (this.seen.size > LIMIT) this.seen.delete(this.seen.values().next().value!)
    if (changed) try { this.storage?.setItem(this.key, JSON.stringify([...this.seen])) } catch { /* Keep in-memory deduplication. */ }
    // One short notice, not a burst of popups after reconnection. No locally
    // incremented ordinal: the UI never invents a fifth point or personal credit.
    return fresh.sort((a, b) => (b.lastVisitedAt ?? '').localeCompare(a.lastVisitedAt ?? ''))[0] ?? null
  }
}
