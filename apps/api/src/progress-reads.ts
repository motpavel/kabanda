import type { Pool } from 'pg'
import { z } from 'zod'
import { IZHEVSK_KB_STORES } from '@kabanda/contracts'
import { RaidError, type RaidMetrics } from './raids.js'

export type HistoryFilter = 'all' | 'mine'
export type HistoryReadInput = { limit: number; filter: HistoryFilter; cursor?: string | undefined }
export type PointProgressInput = { category: 'stores' | 'attractions'; pointIds?: string[] | undefined }
export type ProgressHistoryPage = {
  raids: Array<{ raidId: string; title: string; completedAt: string; partial: boolean; participated: boolean; team: RaidMetrics; personal: RaidMetrics }>
  nextCursor: string | null
}
export type PointProgressPage = {
  points: Array<{ stableId: string; pointId: string | null; personalCount: number; teamCount: number }>
}
export interface ProgressReadService {
  history(userId: string, kabandaId: string, input: HistoryReadInput): Promise<ProgressHistoryPage>
  points(userId: string, kabandaId: string, input: PointProgressInput): Promise<PointProgressPage>
}

const cursorSchema = z.object({
  v: z.literal(1), userId: z.uuid(), kabandaId: z.uuid(), filter: z.enum(['all', 'mine']),
  completedAt: z.iso.datetime({ offset: true }), raidId: z.uuid(),
}).strict()
export function decodeProgressHistoryCursor(value: string | undefined, userId: string, kabandaId: string, filter: HistoryFilter) {
  if (!value) return null
  try {
    if (value.length > 768 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('encoding')
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
    if (cursor.userId !== userId || cursor.kabandaId !== kabandaId || cursor.filter !== filter) throw new Error('scope')
    return cursor
  } catch {
    throw new RaidError('HISTORY_CURSOR_INVALID', 400, 'Не удалось продолжить список. Обновите историю.')
  }
}
const distance = (value: number | null) => Math.round(Number(value ?? 0) * 100) / 100
const unavailable = () => new RaidError('NOT_FOUND', 404, 'Кабанда недоступна')

/** Read-only projections of the canonical results and confirmed credits.
 * The original history endpoint remains compatible with old installed PWAs.
 * No awards, snapshots, participant windows or operation queues are changed here. */
export class DatabaseProgressReadService implements ProgressReadService {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async history(userId: string, kabandaId: string, input: HistoryReadInput): Promise<ProgressHistoryPage> {
    const limit = z.number().int().min(1).max(50).parse(input.limit)
    const filter = z.enum(['all', 'mine']).parse(input.filter)
    const cursor = decodeProgressHistoryCursor(input.cursor, userId, kabandaId, filter)
    const result = await this.pool.query<{
      access_id: string; raid_id: string | null; title: string; completed_at: Date; cursor_at: string;
      partial: boolean; participated: boolean; team_duration_seconds: number; team_distance_meters: number;
      team_unique_points: number; team_photos: number; duration_seconds: number | null;
      distance_meters: number | null; unique_points: number | null; photos: number | null;
    }>(`WITH access AS (
      SELECT k.id FROM kabandas k JOIN kabanda_memberships m ON m.kabanda_id = k.id
      WHERE k.id = $1 AND k.archived_at IS NULL AND m.user_id = $2 AND m.removed_at IS NULL
    ) SELECT access.id AS access_id, page.* FROM access LEFT JOIN LATERAL (
      SELECT rr.raid_id, r.title, rr.completed_at, rr.partial,
        to_char(rr.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
        rp.user_id IS NOT NULL AS participated,
        rr.team_duration_seconds, rr.team_distance_meters, rr.team_unique_points, rr.team_photos,
        rp.duration_seconds, rp.distance_meters, rp.unique_points, rp.photos
      FROM raid_results rr JOIN raids r ON r.id = rr.raid_id AND r.state = 'completed'
      LEFT JOIN raid_result_participants rp ON rp.raid_id = rr.raid_id AND rp.user_id = $2
      WHERE rr.kabanda_id = access.id
        AND ($3::text = 'all' OR rp.user_id IS NOT NULL)
        AND ($4::timestamptz IS NULL OR (rr.completed_at, rr.raid_id) < ($4, $5::uuid))
      ORDER BY rr.completed_at DESC, rr.raid_id DESC LIMIT $6
    ) page ON true`, [kabandaId, userId, filter, cursor?.completedAt ?? null, cursor?.raidId ?? null, limit + 1])
    if (!result.rows.length) throw unavailable()
    const candidates = result.rows.filter(row => row.raid_id !== null)
    const rows = candidates.slice(0, limit)
    const last = rows.at(-1)
    return {
      raids: rows.map(row => ({
        raidId: row.raid_id!, title: row.title, completedAt: row.completed_at.toISOString(),
        partial: row.partial, participated: row.participated,
        team: { durationSeconds: Number(row.team_duration_seconds), distanceMeters: distance(row.team_distance_meters), uniquePoints: Number(row.team_unique_points), photos: Number(row.team_photos) },
        personal: { durationSeconds: Number(row.duration_seconds ?? 0), distanceMeters: distance(row.distance_meters), uniquePoints: Number(row.unique_points ?? 0), photos: Number(row.photos ?? 0) },
      })),
      // Keep PostgreSQL microseconds: Date.toISOString() would lose a boundary
      // and skip rows whose completion times lie within the same millisecond.
      nextCursor: candidates.length > limit && last ? Buffer.from(JSON.stringify({
        v: 1, userId, kabandaId, filter, completedAt: last.cursor_at, raidId: last.raid_id,
      })).toString('base64url') : null,
    }
  }

  async points(userId: string, kabandaId: string, input: PointProgressInput): Promise<PointProgressPage> {
    const category = z.enum(['stores', 'attractions']).parse(input.category)
    const ids = [...new Set(z.array(z.uuid()).max(100).parse(input.pointIds ?? []))]
    const stores = IZHEVSK_KB_STORES.map(store => store.id)
    const result = await this.pool.query<{
      access_id: string; stable_id: string | null; point_id: string | null; personal_count: string; team_count: string;
    }>(`WITH access AS (
      SELECT k.id, m.role FROM kabandas k JOIN kabanda_memberships m ON m.kabanda_id = k.id
      WHERE k.id = $1 AND k.archived_at IS NULL AND m.user_id = $2 AND m.removed_at IS NULL
    ), catalogue AS (
      SELECT store.id AS stable_id, p.id AS point_id FROM access
      CROSS JOIN unnest($4::text[]) AS store(id)
      LEFT JOIN points p ON p.kabanda_id = access.id AND p.stable_key = store.id
        AND p.source = 'kb_store' AND p.archived_at IS NULL
      WHERE $3::text = 'stores'
      UNION ALL
      SELECT p.stable_key, p.id FROM points p JOIN access ON access.id = p.kabanda_id
      WHERE $3::text = 'attractions' AND p.id = ANY($5::uuid[]) AND p.archived_at IS NULL
        AND p.source NOT IN ('kb_store', 'raid_template')
        AND EXISTS (SELECT 1 FROM collection_points cp JOIN point_collections pc ON pc.id = cp.collection_id
          WHERE cp.point_id = p.id AND cp.archived_at IS NULL AND pc.archived_at IS NULL AND pc.kabanda_id = access.id)
    ), confirmed AS (
      SELECT s.source_point_id AS point_id, c.user_id
      FROM raid_point_credits c
      JOIN raid_point_visit_events event ON event.credit_id = c.id
      JOIN raid_point_snapshots s ON s.id = c.point_snapshot_id
      JOIN catalogue cat ON cat.point_id = s.source_point_id
      JOIN raids r ON r.id = c.raid_id
      JOIN access ON access.id = r.kabanda_id
      WHERE (r.state = 'completed' AND EXISTS (
        SELECT 1 FROM raid_result_points final WHERE final.raid_id = r.id
          AND final.user_id = c.user_id AND final.source_point_id = s.source_point_id
      )) OR (r.state IN ('active', 'paused', 'finalizing') AND (
        access.role = 'owner' OR EXISTS (SELECT 1 FROM raid_participants viewer
          WHERE viewer.raid_id = r.id AND viewer.user_id = $2 AND viewer.state = 'active')
      ))
      UNION ALL
      SELECT v.point_id, v.user_id FROM point_visits v JOIN access ON access.id = v.kabanda_id
      JOIN catalogue cat ON cat.point_id = v.point_id
    ), counts AS (
      SELECT point_id, count(*) FILTER (WHERE user_id = $2)::text AS personal_count,
        count(*)::text AS team_count FROM confirmed GROUP BY point_id
    ) SELECT access.id AS access_id, cat.stable_id, cat.point_id,
      coalesce(counts.personal_count, '0') AS personal_count, coalesce(counts.team_count, '0') AS team_count
      FROM access LEFT JOIN catalogue cat ON true LEFT JOIN counts ON counts.point_id = cat.point_id
      ORDER BY cat.stable_id`, [kabandaId, userId, category, stores, ids])
    if (!result.rows.length) throw unavailable()
    return { points: result.rows.filter(row => row.stable_id !== null).map(row => ({
      stableId: row.stable_id!, pointId: row.point_id, personalCount: Number(row.personal_count), teamCount: Number(row.team_count),
    })) }
  }
}
