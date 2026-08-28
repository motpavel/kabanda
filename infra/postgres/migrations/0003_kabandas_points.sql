CREATE TYPE kabanda_membership_role AS ENUM ('owner', 'member');

CREATE TABLE kabandas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  avatar text NOT NULL DEFAULT '🐗' CHECK (char_length(avatar) BETWEEN 1 AND 8),
  owner_id uuid NOT NULL REFERENCES users(id),
  create_idempotency_key text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, create_idempotency_key)
);

CREATE TABLE kabanda_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kabanda_id uuid NOT NULL REFERENCES kabandas(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role kabanda_membership_role NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  UNIQUE (kabanda_id, user_id)
);

CREATE UNIQUE INDEX kabanda_single_owner_idx
  ON kabanda_memberships (kabanda_id) WHERE role = 'owner' AND removed_at IS NULL;
CREATE INDEX kabanda_memberships_active_user_idx
  ON kabanda_memberships (user_id, kabanda_id) WHERE removed_at IS NULL;

CREATE TABLE kabanda_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kabanda_id uuid NOT NULL REFERENCES kabandas(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX kabanda_invites_active_idx
  ON kabanda_invites (kabanda_id, expires_at)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;

CREATE TABLE invite_continuations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id uuid NOT NULL REFERENCES kabanda_invites(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invite_continuations_expiry_idx ON invite_continuations (expires_at);

CREATE TABLE invite_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id uuid NOT NULL REFERENCES kabanda_invites(id) ON DELETE RESTRICT,
  continuation_id uuid NOT NULL REFERENCES invite_continuations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL REFERENCES kabanda_memberships(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invite_id),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE point_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kabanda_id uuid NOT NULL REFERENCES kabandas(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  stable_key text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX point_collections_stable_key_idx
  ON point_collections (kabanda_id, stable_key) WHERE stable_key IS NOT NULL;

CREATE TABLE points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_key text NOT NULL UNIQUE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  location geometry(Point, 4326) NOT NULL,
  source text NOT NULL,
  source_id text NOT NULL,
  source_url text NOT NULL,
  license text NOT NULL,
  verification_status text NOT NULL
    CHECK (verification_status IN ('source_checked', 'field_verified', 'rejected')),
  verified_at timestamptz,
  notes text NOT NULL DEFAULT '',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);

CREATE INDEX points_location_gist_idx ON points USING gist (location);

CREATE TABLE collection_points (
  collection_id uuid NOT NULL REFERENCES point_collections(id) ON DELETE CASCADE,
  point_id uuid NOT NULL REFERENCES points(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position >= 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, point_id),
  UNIQUE (collection_id, position)
);

CREATE TABLE point_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kabanda_id uuid NOT NULL REFERENCES kabandas(id) ON DELETE RESTRICT,
  point_id uuid NOT NULL REFERENCES points(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  point_name_snapshot text NOT NULL,
  point_location_snapshot geometry(Point, 4326) NOT NULL,
  visited_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX point_visits_kabanda_point_idx ON point_visits (kabanda_id, point_id);
CREATE INDEX point_visits_user_point_idx ON point_visits (user_id, point_id);

CREATE TABLE point_import_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kabanda_id uuid NOT NULL REFERENCES kabandas(id) ON DELETE CASCADE,
  collection_id uuid REFERENCES point_collections(id) ON DELETE SET NULL,
  manifest_key text NOT NULL,
  checksum char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'completed')) DEFAULT 'pending',
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (kabanda_id, manifest_key)
);
