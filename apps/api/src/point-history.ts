import type { Pool } from 'pg'
import type { PointVisitHistory } from '@kabanda/contracts'
import { KabandaError } from './kabandas.js'

// Read confirmed visits, not attempts: retries and delayed outbox replay must
// never inflate the personal count. Completed raids use the frozen result.
export async function readPointVisitHistory(
  pool: Pool, userId: string, kabandaId: string, pointId: string, offset = 0,
): Promise<PointVisitHistory> {
  const access = await pool.query(
    `SELECT 1 FROM kabanda_memberships m
     JOIN kabandas k ON k.id = m.kabanda_id AND k.archived_at IS NULL
     JOIN points p ON p.id = $3 AND p.kabanda_id = k.id
     WHERE m.user_id = $1 AND m.kabanda_id = $2 AND m.removed_at IS NULL`,
    [userId, kabandaId, pointId],
  )
  if (!access.rowCount) throw new KabandaError('NOT_FOUND', 404, 'Точка недоступна')
  const result = await pool.query<{
    id: string; raid_id: string | null; title: string; state: string | null
    visited_at: Date; mine: boolean; visits: PointVisitHistory['entries'][number]['visits']
    participants: PointVisitHistory['entries'][number]['participants']; personal_visits: string; personal_total: string; total_count: string
  }>(
    `WITH visible_credits AS (
       SELECT c.raid_id, c.user_id, event.id AS visit_id, event.source, a.evidence_captured_at AS visited_at,
         coalesce(rp.display_name, u.display_name, u.username, 'Участник') AS display_name,
         r.title, r.state
       FROM raid_point_credits c
       JOIN raid_point_visit_events event ON event.credit_id = c.id
       JOIN raid_point_snapshots s ON s.id = c.point_snapshot_id AND s.source_point_id = $3
       JOIN raid_checkin_attempts a ON a.id = event.evidence_attempt_id
       JOIN raids r ON r.id = c.raid_id AND r.kabanda_id = $2
       JOIN users u ON u.id = c.user_id
       LEFT JOIN raid_result_participants rp ON rp.raid_id = r.id AND rp.user_id = c.user_id
       WHERE (r.state = 'completed' AND EXISTS (
         SELECT 1 FROM raid_result_points final
         WHERE final.raid_id = r.id AND final.user_id = c.user_id AND final.source_point_id = $3
       )) OR (r.state IN ('active', 'paused', 'finalizing') AND (
         EXISTS (SELECT 1 FROM raid_participants viewer WHERE viewer.raid_id = r.id
           AND viewer.user_id = $1 AND viewer.state = 'active')
         OR EXISTS (SELECT 1 FROM kabanda_memberships owner WHERE owner.kabanda_id = $2
           AND owner.user_id = $1 AND owner.role = 'owner' AND owner.removed_at IS NULL)
       ))
     ), entries AS (
       SELECT raid_id::text AS id, raid_id, title, state::text,
         max(visited_at) AS visited_at, bool_or(user_id = $1) AS mine,
         count(*) FILTER (WHERE user_id = $1)::text AS personal_visits,
         jsonb_agg(jsonb_build_object('id', visit_id, 'userId', user_id, 'displayName', display_name,
           'visitedAt', visited_at, 'source', source) ORDER BY visited_at, user_id) AS visits,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('userId', p.user_id, 'displayName',
             coalesce(f.display_name, u.display_name, u.username, 'Участник')) ORDER BY p.user_id), '[]')
          FROM raid_participants p JOIN users u ON u.id = p.user_id
          LEFT JOIN raid_result_participants f ON f.raid_id = p.raid_id AND f.user_id = p.user_id
          WHERE p.raid_id = visible_credits.raid_id AND (p.active_from IS NOT NULL OR f.user_id IS NOT NULL)) AS participants
       FROM visible_credits GROUP BY raid_id, title, state
       UNION ALL
       SELECT v.id::text, NULL::uuid, 'Отметка без рейда', NULL::text, v.visited_at, v.user_id = $1,
         CASE WHEN v.user_id = $1 THEN '1' ELSE '0' END,
         jsonb_build_array(jsonb_build_object('id', v.id, 'userId', v.user_id, 'displayName',
           coalesce(u.display_name, u.username, 'Участник'), 'visitedAt', v.visited_at, 'source', 'legacy')),
         '[]'::jsonb
       FROM point_visits v JOIN users u ON u.id = v.user_id
       WHERE v.kabanda_id = $2 AND v.point_id = $3
     ), totals AS (
       SELECT coalesce(sum(personal_visits::int), 0)::text AS personal_total, count(*)::text AS total_count FROM entries
     )
     SELECT page.*, totals.* FROM totals LEFT JOIN LATERAL (
       SELECT * FROM entries ORDER BY visited_at DESC, id DESC LIMIT 20 OFFSET $4
     ) page ON true`,
    [userId, kabandaId, pointId, offset],
  )
  const totalCount = Number(result.rows[0]?.total_count ?? 0)
  const entries = result.rows.filter((row) => row.id).map((row) => ({
    id: row.id, raidId: row.raid_id, title: row.title, state: row.state,
    visitedAt: row.visited_at.toISOString(), mine: row.mine, personalVisits: Number(row.personal_visits), visits: row.visits, participants: row.participants,
  }))
  return { personalCount: Number(result.rows[0]?.personal_total ?? 0), entries,
    nextOffset: offset + entries.length < totalCount ? offset + entries.length : null }
}
