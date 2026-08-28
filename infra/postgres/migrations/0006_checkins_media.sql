CREATE TABLE raid_point_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  source_point_id uuid NOT NULL REFERENCES points(id) ON DELETE RESTRICT,
  collection_id uuid NOT NULL REFERENCES point_collections(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  location geography(Point, 4326) NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raid_id, source_point_id)
);

CREATE INDEX raid_point_snapshots_location_idx
  ON raid_point_snapshots USING gist (location);

CREATE TABLE raid_checkin_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE RESTRICT,
  point_snapshot_id uuid NOT NULL REFERENCES raid_point_snapshots(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  evidence_location geography(Point, 4326) NOT NULL,
  evidence_captured_at timestamptz NOT NULL,
  evidence_accuracy_meters double precision NOT NULL CHECK (evidence_accuracy_meters >= 0),
  organizer_attestation boolean NOT NULL DEFAULT false,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'needs_manual_verification')),
  reason text CHECK (reason IS NULL OR reason IN (
    'location_expired', 'accuracy_insufficient', 'too_far'
  )),
  distance_meters double precision CHECK (distance_meters IS NULL OR distance_meters >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX raid_checkin_attempts_raid_point_idx
  ON raid_checkin_attempts (raid_id, point_snapshot_id, created_at DESC);

CREATE TABLE raid_point_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE RESTRICT,
  point_snapshot_id uuid NOT NULL REFERENCES raid_point_snapshots(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN (
    'gps', 'organizer_attestation', 'claim', 'media_fallback'
  )),
  evidence_attempt_id uuid NOT NULL REFERENCES raid_checkin_attempts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raid_id, point_snapshot_id, user_id)
);

CREATE INDEX raid_point_credits_user_idx
  ON raid_point_credits (raid_id, user_id, created_at DESC);

CREATE TABLE raid_checkin_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL REFERENCES raid_checkin_attempts(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'declined')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, user_id)
);

CREATE INDEX raid_checkin_claims_inbox_idx
  ON raid_checkin_claims (user_id, status, expires_at, created_at DESC);

CREATE TABLE raid_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE RESTRICT,
  uploader_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attempt_id uuid REFERENCES raid_checkin_attempts(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('gallery', 'fallback')),
  caption text CHECK (caption IS NULL OR char_length(caption) <= 160),
  source_sha256 char(64) NOT NULL,
  declared_size_bytes integer NOT NULL CHECK (declared_size_bytes BETWEEN 1 AND 8388608),
  declared_content_type text NOT NULL CHECK (
    declared_content_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  upload_capability_hash char(64) NOT NULL UNIQUE,
  upload_expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending_upload'
    CHECK (state IN ('pending_upload', 'processing', 'ready', 'tombstoned')),
  processing_started_at timestamptz,
  content_bytes bytea,
  content_type text,
  size_bytes integer,
  width integer,
  height integer,
  content_sha256 char(64),
  ready_at timestamptz,
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state <> 'ready') OR (
    content_bytes IS NOT NULL AND content_type = 'image/jpeg' AND
    size_bytes BETWEEN 1 AND 3145728 AND width BETWEEN 1 AND 2048 AND height BETWEEN 1 AND 2048
  )),
  CHECK ((state <> 'tombstoned') OR (content_bytes IS NULL AND tombstoned_at IS NOT NULL))
);

CREATE INDEX raid_media_gallery_idx
  ON raid_media (raid_id, created_at DESC, id DESC) WHERE state = 'ready';

CREATE TABLE raid_checkin_fallbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL REFERENCES raid_checkin_attempts(id) ON DELETE RESTRICT,
  media_id uuid NOT NULL REFERENCES raid_media(id) ON DELETE RESTRICT,
  requester_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  verifier_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  present_participant_ids uuid[] NOT NULL DEFAULT '{}',
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 240),
  status text NOT NULL DEFAULT 'pending_verifier'
    CHECK (status IN ('pending_verifier', 'confirmed', 'declined')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requester_user_id <> verifier_user_id)
);

CREATE INDEX raid_checkin_fallbacks_verifier_idx
  ON raid_checkin_fallbacks (verifier_user_id, status, expires_at, created_at DESC);

CREATE UNIQUE INDEX raid_checkin_fallbacks_one_open_request_idx
  ON raid_checkin_fallbacks (attempt_id, requester_user_id)
  WHERE status <> 'declined';

CREATE TABLE raid_feature_receipts (
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_id text NOT NULL CHECK (char_length(operation_id) BETWEEN 8 AND 100),
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE RESTRICT,
  command text NOT NULL CHECK (char_length(command) BETWEEN 1 AND 48),
  request_fingerprint char(64) NOT NULL,
  response_json jsonb NOT NULL CHECK (octet_length(response_json::text) <= 65536),
  CHECK (command <> 'create-media-intent' OR NOT (response_json ? 'uploadCapability')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, operation_id)
);

CREATE INDEX raid_feature_receipts_raid_idx
  ON raid_feature_receipts (raid_id, created_at DESC);
