import type { FieldOperation } from '../raids/field-outbox'
import type { PointMaterial } from './PointMaterialsPanel'

export type PointCommentRow = {
  id: string; body: string; authorName: string; createdAt: string | number
  state: 'confirmed' | 'pending' | 'sending' | 'retryable' | 'rejected'
}

/** Read-only projection. A committed local comment stays visible while the
 * material list catches up; a server ID, never equal text, identifies duplicates.
 * Local data belongs exclusively to the current identity / raid / point. */
export function pointCommentRows(items: readonly PointMaterial[], operations: readonly FieldOperation[],
  scope: { identityId: string; raidId: string; pointId: string }): PointCommentRow[] {
  const comments = items.filter(item => item.pointSnapshotId === scope.pointId && item.kind === 'comment' && item.ready)
  const serverIds = new Set(comments.map(item => item.id))
  const rows: PointCommentRow[] = comments.map(item => ({ id: item.id, body: item.body,
    authorName: item.authorName || (item.authorUserId === scope.identityId ? 'Вы' : 'Участник рейда'),
    createdAt: item.createdAt, state: 'confirmed' }))
  // Last entry wins when the caller joins an immediate enqueue result with a
  // newer durable queue snapshot. No payload/queue row is mutated here.
  const local = new Map(operations.map(operation => [operation.operationId, operation]))
  for (const operation of local.values()) {
    if (operation.identityId !== scope.identityId || operation.raidId !== scope.raidId ||
      operation.pointId !== scope.pointId || operation.kind !== 'comment' ||
      !('kind' in operation.payload) || operation.payload.kind !== 'comment') continue
    if (operation.serverId && serverIds.has(operation.serverId)) continue
    rows.push({ id: `local:${operation.operationId}`, body: operation.payload.body, authorName: 'Вы',
      createdAt: operation.createdAt, state: operation.status === 'accepted' ? 'confirmed' : operation.status })
  }
  return rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id))
}
