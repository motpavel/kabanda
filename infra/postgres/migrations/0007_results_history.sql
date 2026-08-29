ALTER TABLE raids
  ADD COLUMN finalization_deadline_at timestamptz,
  ADD COLUMN finalization_partial boolean NOT NULL DEFAULT false,
  ADD COLUMN finalization_inventory jsonb;

ALTER TABLE raids ADD CHECK (
  finalization_inventory IS NULL OR octet_length(finalization_inventory::text) <= 1024
);

ALTER TABLE raids ADD CHECK (
  (state NOT IN ('finalizing', 'completed'))
  OR (finalizing_at IS NOT NULL AND finalization_deadline_at IS NOT NULL)
);

ALTER TABLE raid_navigator_leases
  DROP CONSTRAINT raid_navigator_leases_ended_reason_check;
ALTER TABLE raid_navigator_leases
  ADD CHECK (
    ended_reason IS NULL OR ended_reason IN ('pause', 'cancel', 'handoff', 'recover', 'finish')
  );

ALTER TABLE raid_checkin_claims DROP CONSTRAINT raid_checkin_claims_status_check;
ALTER TABLE raid_checkin_claims ADD CHECK (
  status IN ('pending', 'confirmed', 'declined', 'expired_finalization')
);

ALTER TABLE raid_checkin_fallbacks DROP CONSTRAINT raid_checkin_fallbacks_status_check;
ALTER TABLE raid_checkin_fallbacks ADD CHECK (
  status IN ('pending_verifier', 'confirmed', 'declined', 'expired_finalization')
);

ALTER TABLE raid_media DROP CONSTRAINT raid_media_state_check;
ALTER TABLE raid_media ADD CHECK (
  state IN ('pending_upload', 'processing', 'ready', 'tombstoned', 'expired_finalization')
);
ALTER TABLE raid_media ADD COLUMN processing_token uuid;
UPDATE raid_media SET state = 'pending_upload', processing_started_at = NULL
  WHERE state = 'processing';
ALTER TABLE raid_media ADD CHECK (
  (state = 'processing' AND processing_started_at IS NOT NULL AND processing_token IS NOT NULL)
  OR (state <> 'processing' AND processing_token IS NULL)
);
ALTER TABLE raid_media ADD CHECK (
  state <> 'expired_finalization' OR content_bytes IS NULL
);

CREATE TABLE raid_route_finalization_cutoffs (
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE RESTRICT,
  lease_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  max_sequence bigint NOT NULL CHECK (max_sequence >= 0),
  cutoff_at timestamptz NOT NULL,
  PRIMARY KEY (raid_id, lease_id),
  UNIQUE (raid_id, generation),
  FOREIGN KEY (raid_id, lease_id)
    REFERENCES raid_navigator_leases(raid_id, id) ON DELETE RESTRICT
);

CREATE TABLE raid_results (
  raid_id uuid PRIMARY KEY REFERENCES raids(id) ON DELETE RESTRICT,
  kabanda_id uuid NOT NULL REFERENCES kabandas(id) ON DELETE RESTRICT,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  partial boolean NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  team_duration_seconds integer NOT NULL CHECK (team_duration_seconds >= 0),
  team_distance_meters double precision NOT NULL CHECK (team_distance_meters >= 0),
  team_unique_points integer NOT NULL CHECK (team_unique_points >= 0),
  team_photos integer NOT NULL CHECK (team_photos >= 0),
  result_json jsonb NOT NULL CHECK (octet_length(result_json::text) <= 65536),
  share_png bytea NOT NULL CHECK (octet_length(share_png) BETWEEN 64 AND 1048576),
  share_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX raid_results_history_idx
  ON raid_results (kabanda_id, completed_at DESC, raid_id DESC);

CREATE TABLE raid_result_participants (
  raid_id uuid NOT NULL REFERENCES raid_results(raid_id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
  duration_seconds integer NOT NULL CHECK (duration_seconds >= 0),
  distance_meters double precision NOT NULL CHECK (distance_meters >= 0),
  unique_points integer NOT NULL CHECK (unique_points >= 0),
  photos integer NOT NULL CHECK (photos >= 0),
  PRIMARY KEY (raid_id, user_id)
);

CREATE INDEX raid_result_participants_progress_idx
  ON raid_result_participants (user_id, raid_id);

CREATE TABLE raid_result_points (
  raid_id uuid NOT NULL REFERENCES raid_results(raid_id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_point_id uuid NOT NULL REFERENCES points(id) ON DELETE RESTRICT,
  PRIMARY KEY (raid_id, user_id, source_point_id)
);

CREATE INDEX raid_result_points_user_idx
  ON raid_result_points (user_id, source_point_id);

CREATE FUNCTION prevent_raid_result_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'raid result rows are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER raid_results_immutable
  BEFORE UPDATE OR DELETE ON raid_results
  FOR EACH ROW EXECUTE FUNCTION prevent_raid_result_mutation();
CREATE TRIGGER raid_result_participants_immutable
  BEFORE UPDATE OR DELETE ON raid_result_participants
  FOR EACH ROW EXECUTE FUNCTION prevent_raid_result_mutation();
CREATE TRIGGER raid_result_points_immutable
  BEFORE UPDATE OR DELETE ON raid_result_points
  FOR EACH ROW EXECUTE FUNCTION prevent_raid_result_mutation();
