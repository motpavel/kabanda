import { z } from 'zod'
import type { Pool } from 'pg'
import { IZHEVSK_KB_STORES } from '@kabanda/contracts'
import { historyPageQuerySchema, type HistoryPage, type HistoryScope, type PointProgress, type PointProgressQuery } from '@kabanda/contracts/exploration'
import { KabandaError } from './kabandas.js'

type Database = Pick<Pool, 'query'>
const unavailable = () => new KabandaError('NOT_FOUND', 404, 'Кабанда или её данные недоступны')
const cursorSchema = z.strictObject({
  v: z.literal(2), user: z.uuid(), team: z.uuid(), scope: z.enum(['all', 'mine']),
  at: z.iso.datetime({ offset: true }), id: z.uuid(),
})
export function parseHistoryPageCursor(raw: string | undefined, user: string, team: string, scope: HistoryScope) {
  if (!raw) return null
  try {
    if (raw.length > 640 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('Invalid cursor')
    const value = cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')))
    if (value.user !== user || value.team !== team || value.scope !== scope) throw new Error('Cursor context changed')
    return value
  } catch {
    throw new KabandaError('HISTORY_CURSOR_INVALID', 400, 'Список изменился. Обновите историю.')
  }
}

/** Opt-in read protocol for installed-PWA compatibility. The old endpoint stays
 * available; both read the same immutable result tables, not another score model. */
export async function readHistoryPage(database: Database, user: string, team: string,
  input: { scope: HistoryScope; limit: number; cursor?: string | undefined }): Promise<HistoryPage> {
  const { scope, limit, cursor } = historyPageQuerySchema.parse(input)
  const after = parseHistoryPageCursor(cursor, user, team, scope)
  const result = await database.query<{
    raid_id: string | null; title: string; completed_at: Date; cursor_at: string; partial: boolean; participated: boolean
    team_duration_seconds: number; team_distance_meters: number; team_unique_points: number; team_photos: number
    duration_seconds: number | null; distance_meters: number | null; unique_points: number | null; photos: number | null
  }>(
    `WITH allowed AS (
       SELECT m.kabanda_id FROM kabanda_memberships m
       JOIN kabandas k ON k.id = m.kabanda_id AND k.archived_at IS NULL
       WHERE m.user_id = $1 AND m.kabanda_id = $2 AND m.removed_at IS NULL
     )
     SELECT page.* FROM allowed a LEFT JOIN LATERAL (
       SELECT rr.raid_id, r.title, rr.completed_at, rr.partial,
         to_char(rr.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
         rr.team_duration_seconds, rr.team_distance_meters, rr.team_unique_points, rr.team_photos,
         rp.duration_seconds, rp.distance_meters, rp.unique_points, rp.photos,
         (rp.user_id IS NOT NULL) AS participated
       FROM raid_results rr JOIN raids r ON r.id = rr.raid_id AND r.state = 'completed'
       LEFT JOIN raid_result_participants rp ON rp.raid_id = rr.raid_id AND rp.user_id = $1
       WHERE rr.kabanda_id = a.kabanda_id AND r.kabanda_id = a.kabanda_id
         AND ($3::text = 'all' OR rp.user_id IS NOT NULL)
         AND ($4::timestamptz IS NULL OR (rr.completed_at, rr.raid_id) < ($4, $5::uuid))
       ORDER BY rr.completed_at DESC, rr.raid_id DESC LIMIT $6
     ) page ON true`,
    [user, team, scope, after?.at ?? null, after?.id ?? null, limit + 1],
  )
  if (!result.rowCount) throw unavailable()
  const candidates = result.rows.filter(row => row.raid_id !== null)
  const rows = candidates.slice(0, limit)
  const last = rows.at(-1)
  return {
    schemaVersion: 2, scope,
    raids: rows.map(row => ({
      raidId: row.raid_id!, title: row.title, completedAt: row.completed_at.toISOString(),
      partial: row.partial, participated: row.participated,
      team: { durationSeconds: Number(row.team_duration_seconds), distanceMeters: Number(row.team_distance_meters),
        uniquePoints: Number(row.team_unique_points), photos: Number(row.team_photos) },
      personal: { durationSeconds: Number(row.duration_seconds ?? 0), distanceMeters: Number(row.distance_meters ?? 0),
        uniquePoints: Number(row.unique_points ?? 0), photos: Number(row.photos ?? 0) },
    })),
    // JS Date truncates PostgreSQL microseconds. The keyset cursor must use the
    // exact SQL value, otherwise equal timestamps can skip a whole page.
    nextCursor: candidates.length > limit && last ? Buffer.from(JSON.stringify({
      v: 2, user, team, scope, at: last.cursor_at, id: last.raid_id,
    })).toString('base64url') : null,
  }
}

/** One bounded read for the map. Counts refer to individual credited visits,
 * not group stops. Frozen results authorize completed visits; live credits keep
 * the existing owner / active-viewer rule. Pending attempts cannot award visits. */
export async function readPointProgress(database: Database, user: string, team: string,
  input: PointProgressQuery): Promise<PointProgress> {
  const collection = input.category === 'attractions' ? input.collection ?? null : null
  const result = await database.query<{
    collection_available: boolean; stable_key: string | null; point_id: string | null; personal_count: string; team_count: string
  }>(
    `WITH allowed AS (
       SELECT m.kabanda_id, m.role,
         ($3::text = 'stores' OR EXISTS (
           SELECT 1 FROM point_collections pc WHERE pc.id = $4::uuid
             AND pc.kabanda_id = k.id AND pc.archived_at IS NULL
         )) AS collection_available
       FROM kabanda_memberships m
       JOIN kabandas k ON k.id = m.kabanda_id AND k.archived_at IS NULL
       WHERE m.user_id = $1 AND m.kabanda_id = $2 AND m.removed_at IS NULL
     ), catalog AS (
       SELECT s.stable_key, p.id AS point_id FROM allowed a
       CROSS JOIN jsonb_array_elements_text($5::jsonb) s(stable_key)
       LEFT JOIN points p ON p.kabanda_id = a.kabanda_id AND p.stable_key = s.stable_key
         AND p.source = 'kb_store' AND p.archived_at IS NULL
       WHERE $3::text = 'stores' AND a.collection_available
       UNION ALL
       SELECT p.stable_key, p.id FROM allowed a
       JOIN collection_points cp ON cp.collection_id = $4::uuid AND cp.archived_at IS NULL
       JOIN points p ON p.id = cp.point_id AND p.kabanda_id = a.kabanda_id AND p.archived_at IS NULL
       WHERE $3::text = 'attractions' AND a.collection_available
     ), bounded AS (
       SELECT DISTINCT stable_key, point_id FROM catalog ORDER BY stable_key, point_id LIMIT 501
     ), event_counts AS (
       SELECT c.raid_id, c.user_id, s.source_point_id, count(e.id)::bigint AS visits
       FROM raid_point_credits c
       JOIN raid_point_snapshots s ON s.id = c.point_snapshot_id AND s.raid_id = c.raid_id
       JOIN bounded b ON b.point_id = s.source_point_id
       JOIN raids r ON r.id = c.raid_id AND r.kabanda_id = $2
       JOIN raid_point_visit_events e ON e.credit_id = c.id
       GROUP BY c.raid_id, c.user_id, s.source_point_id
     ), visits AS (
       SELECT f.source_point_id, f.user_id, coalesce(e.visits, 1)::bigint AS visits
       FROM raid_result_points f
       JOIN bounded b ON b.point_id = f.source_point_id
       JOIN raid_results rr ON rr.raid_id = f.raid_id AND rr.kabanda_id = $2
       JOIN raids r ON r.id = f.raid_id AND r.kabanda_id = $2 AND r.state = 'completed'
       LEFT JOIN event_counts e ON e.raid_id = f.raid_id AND e.user_id = f.user_id AND e.source_point_id = f.source_point_id
       UNION ALL
       SELECT e.source_point_id, e.user_id, e.visits FROM event_counts e
       JOIN raids r ON r.id = e.raid_id AND r.kabanda_id = $2
       WHERE r.state IN ('active', 'paused', 'finalizing') AND (
         EXISTS (SELECT 1 FROM allowed WHERE role = 'owner') OR
         EXISTS (SELECT 1 FROM raid_participants viewer WHERE viewer.raid_id = r.id
           AND viewer.user_id = $1 AND viewer.state = 'active')
       )
       UNION ALL
       SELECT v.point_id, v.user_id, count(*)::bigint FROM point_visits v
       JOIN bounded b ON b.point_id = v.point_id
       WHERE v.kabanda_id = $2 GROUP BY v.point_id, v.user_id
     ), totals AS (
       SELECT source_point_id, coalesce(sum(visits) FILTER (WHERE user_id = $1), 0)::text AS personal_count,
         sum(visits)::text AS team_count FROM visits GROUP BY source_point_id
     )
     SELECT a.collection_available, b.stable_key, b.point_id, coalesce(t.personal_count, '0') AS personal_count,
       coalesce(t.team_count, '0') AS team_count
     FROM allowed a LEFT JOIN bounded b ON true LEFT JOIN totals t ON t.source_point_id = b.point_id
     ORDER BY b.stable_key, b.point_id`,
    [user, team, input.category, collection, JSON.stringify(IZHEVSK_KB_STORES.map(store => store.id))],
  )
  if (!result.rowCount) throw unavailable()
  if (!result.rows[0]!.collection_available) throw new KabandaError('POINT_COLLECTION_UNAVAILABLE', 404, 'Набор точек недоступен')
  const rows = result.rows.filter(row => row.stable_key !== null)
  return {
    category: input.category, collectionId: collection, complete: rows.length <= 500,
    points: rows.slice(0, 500).map(row => ({ pointId: row.point_id, stableId: row.stable_key!,
      personalCount: Number(row.personal_count), teamCount: Number(row.team_count) })),
  }
}
