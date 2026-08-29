CREATE TABLE raid_navigator_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  navigator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  client_instance_id uuid,
  generation integer NOT NULL CHECK (generation > 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  heartbeat_expires_at timestamptz,
  ended_at timestamptz,
  ended_reason text CHECK (
    ended_reason IS NULL OR ended_reason IN ('pause', 'cancel', 'handoff', 'recover')
  ),
  cutover_sequence bigint CHECK (cutover_sequence IS NULL OR cutover_sequence >= 0),
  max_accepted_sequence bigint NOT NULL DEFAULT 0 CHECK (max_accepted_sequence >= 0),
  accepted_sample_count integer NOT NULL DEFAULT 0 CHECK (accepted_sample_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raid_id, id),
  UNIQUE (raid_id, generation),
  CHECK (
    (client_instance_id IS NULL AND claimed_at IS NULL AND heartbeat_expires_at IS NULL)
    OR
    (client_instance_id IS NOT NULL AND claimed_at IS NOT NULL AND heartbeat_expires_at IS NOT NULL)
  ),
  CHECK (ended_at IS NULL OR ended_at >= issued_at)
);

CREATE UNIQUE INDEX raid_navigator_one_current_idx
  ON raid_navigator_leases (raid_id) WHERE ended_at IS NULL;
CREATE INDEX raid_navigator_lease_actor_idx
  ON raid_navigator_leases (navigator_user_id, raid_id, generation DESC);

CREATE TABLE raid_activity_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  opened_version integer NOT NULL CHECK (opened_version > 0),
  closed_version integer CHECK (closed_version IS NULL OR closed_version >= opened_version),
  CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

CREATE UNIQUE INDEX raid_activity_one_open_idx
  ON raid_activity_windows (raid_id) WHERE closed_at IS NULL;
CREATE INDEX raid_activity_timeline_idx
  ON raid_activity_windows (raid_id, opened_at, closed_at);

CREATE TABLE raid_route_batch_receipts (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_id text NOT NULL CHECK (char_length(operation_id) BETWEEN 8 AND 100),
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE RESTRICT,
  lease_id uuid NOT NULL,
  request_fingerprint char(64) NOT NULL,
  response_json jsonb NOT NULL CHECK (octet_length(response_json::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, operation_id),
  FOREIGN KEY (raid_id, lease_id)
    REFERENCES raid_navigator_leases(raid_id, id) ON DELETE RESTRICT
);

CREATE INDEX raid_route_batch_audit_idx
  ON raid_route_batch_receipts (raid_id, created_at, id);

CREATE TABLE raid_route_samples (
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  lease_id uuid NOT NULL,
  operation_id text NOT NULL CHECK (char_length(operation_id) BETWEEN 8 AND 100),
  sequence bigint NOT NULL CHECK (sequence > 0),
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  geom geography(Point, 4326) NOT NULL,
  accuracy_m double precision NOT NULL CHECK (accuracy_m >= 0 AND accuracy_m <= 10000),
  speed_mps double precision CHECK (speed_mps IS NULL OR speed_mps >= 0),
  heading_deg double precision CHECK (
    heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)
  ),
  payload_hash char(64) NOT NULL,
  PRIMARY KEY (lease_id, sequence),
  UNIQUE (raid_id, operation_id),
  FOREIGN KEY (raid_id, lease_id)
    REFERENCES raid_navigator_leases(raid_id, id) ON DELETE RESTRICT,
  CHECK (
    ST_Y(geom::geometry) BETWEEN 56.7 AND 57.0
    AND ST_X(geom::geometry) BETWEEN 53.0 AND 53.4
  )
);

CREATE INDEX raid_route_samples_timeline_idx
  ON raid_route_samples (raid_id, captured_at, lease_id, sequence);
CREATE INDEX raid_route_samples_geom_idx ON raid_route_samples USING gist (geom);
