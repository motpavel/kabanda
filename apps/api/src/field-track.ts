import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { canReadField, fieldAccess } from './field-service.js'
import { RaidError } from './raids.js'

export const ROUTE_CHANGES_PAGE_SIZE = 80

/** Read-only display projection. Neither the route writer nor scoring uses it. */
export async function readRouteChanges(pool: Pool, userId: string, raidId: string, after: string, previousEpoch?: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const access = await fieldAccess(client, userId, raidId)
    if (!canReadField(access) || !['active', 'paused', 'finalizing', 'completed'].includes(access.state)) {
      throw new RaidError('RAID_NOT_FOUND', 404, 'Маршрут недоступен')
    }
    const windows = await client.query('SELECT opened_at, closed_at FROM raid_activity_windows WHERE raid_id=$1 ORDER BY opened_at,id', [raidId])
    const cutoffs = await client.query('SELECT lease_id,max_sequence::text FROM raid_route_finalization_cutoffs WHERE raid_id=$1 ORDER BY lease_id', [raidId])
    const epoch = createHash('sha256').update(JSON.stringify([access.state, windows.rows, cutoffs.rows])).digest('hex')
    const reset = previousEpoch !== epoch
    const cursor = reset ? '0' : after
    const page = await client.query<{ sync_ordinal: string; lease_id: string; sequence: string }>(
      `SELECT sync_ordinal::text,lease_id,sequence::text FROM raid_route_samples
       WHERE raid_id=$1 AND sync_ordinal>$2::bigint ORDER BY sync_ordinal LIMIT $3`, [raidId, cursor, ROUTE_CHANGES_PAGE_SIZE + 1],
    )
    const selected = page.rows.slice(0, ROUTE_CHANGES_PAGE_SIZE)
    // A late sequence can repair the edge of a point delivered on an earlier
    // page. Return that successor too. At most 160 compact records keeps the
    // normal route delta below the encrypted relay's inline body threshold.
    const rows = selected.length ? await client.query(
      `WITH changed AS (
         SELECT lease_id,sequence FROM raid_route_samples
         WHERE raid_id=$1 AND sync_ordinal=ANY($2::bigint[])
       ), affected AS (
         SELECT lease_id,sequence FROM changed
         UNION SELECT s.lease_id,s.sequence FROM raid_route_samples s
           JOIN changed c ON s.lease_id=c.lease_id AND s.sequence=c.sequence+1
           WHERE s.raid_id=$1
       )
       SELECT s.sync_ordinal::text,s.lease_id,l.generation,s.sequence::text,s.captured_at,
         ST_Y(s.geom::geometry) AS latitude,ST_X(s.geom::geometry) AS longitude,
         s.accuracy_m,s.speed_mps,
         (s.accuracy_m<=50 AND ($3 IN ('active','paused') OR s.sequence<=f.max_sequence)
           AND EXISTS(SELECT 1 FROM raid_activity_windows w WHERE w.raid_id=$1
             AND s.captured_at>=w.opened_at AND (w.closed_at IS NULL OR s.captured_at<=w.closed_at))) AS visible,
         (p.sequence IS NOT NULL AND p.accuracy_m<=50
           AND extract(epoch FROM (s.captured_at-p.captured_at)) BETWEEN 0 AND 120
           AND ST_Distance(s.geom,p.geom)<=2000
           AND ST_Distance(s.geom,p.geom)/greatest(extract(epoch FROM (s.captured_at-p.captured_at)),0.001)<=50
           AND EXISTS(SELECT 1 FROM raid_activity_windows w WHERE w.raid_id=$1
             AND p.captured_at>=w.opened_at AND (w.closed_at IS NULL OR s.captured_at<=w.closed_at))) AS continues_previous
       FROM affected a JOIN raid_route_samples s ON s.lease_id=a.lease_id AND s.sequence=a.sequence AND s.raid_id=$1
       JOIN raid_navigator_leases l ON l.id=s.lease_id AND l.raid_id=s.raid_id
       LEFT JOIN raid_route_samples p ON p.lease_id=s.lease_id AND p.sequence=s.sequence-1 AND p.raid_id=s.raid_id
       LEFT JOIN raid_route_finalization_cutoffs f ON f.raid_id=s.raid_id AND f.lease_id=s.lease_id
       ORDER BY l.generation,s.sequence`, [raidId, selected.map(row => row.sync_ordinal), access.state],
    ) : { rows: [] }
    await client.query('COMMIT')
    return { schemaVersion: 1 as const, raidId, epoch, reset,
      cursor: selected.at(-1)?.sync_ordinal ?? cursor, hasMore: page.rows.length > selected.length,
      serverAt: access.server_at.toISOString(), records: rows.rows.map(row => ({
        ordinal: row.sync_ordinal, leaseId: row.lease_id, generation: row.generation, sequence: row.sequence,
        latitude: Number(row.latitude), longitude: Number(row.longitude), capturedAt: row.captured_at.toISOString(),
        accuracyMeters: Number(row.accuracy_m), speedMps: row.speed_mps === null ? null : Number(row.speed_mps),
        visible: row.visible === true, continuesPrevious: row.continues_previous === true,
      })),
    }
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
