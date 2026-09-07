-- Repair only unfinished free hunts. Preserve snapshot IDs, credits, route
-- samples and completed history. Source checking is not field verification:
-- GPS/organizer evidence is still required to credit a visit.
WITH missing AS (
  SELECT DISTINCT ON (r.id, p.id)
    r.id AS raid_id, p.id AS source_point_id, pc.id AS collection_id,
    p.name, p.location::geography AS location, cp.position
  FROM raids r
  JOIN kabandas k ON k.id = r.kabanda_id AND k.archived_at IS NULL
  JOIN point_collections pc ON pc.kabanda_id = r.kabanda_id AND pc.archived_at IS NULL
  JOIN collection_points cp ON cp.collection_id = pc.id AND cp.archived_at IS NULL
  JOIN points p ON p.id = cp.point_id AND p.archived_at IS NULL
  WHERE r.state IN ('active', 'paused') AND r.route_template_id IS NULL
    AND (r.point_category = 'attractions' OR r.point_category IS NULL)
    AND p.verification_status IN ('source_checked', 'field_verified')
    AND p.source NOT IN ('kb_store', 'raid_template')
  ORDER BY r.id, p.id, pc.created_at DESC, pc.id
)
INSERT INTO raid_point_snapshots (raid_id, source_point_id, collection_id, name, location, position)
SELECT raid_id, source_point_id, collection_id, name, location, position FROM missing
ON CONFLICT (raid_id, source_point_id) DO NOTHING;
