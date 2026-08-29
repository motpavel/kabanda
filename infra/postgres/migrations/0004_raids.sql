CREATE TYPE raid_state AS ENUM (
  'draft', 'planned', 'lobby', 'active', 'paused', 'finalizing', 'completed', 'cancelled'
);

CREATE TYPE raid_participant_state AS ENUM (
  'invited', 'accepted', 'declined', 'ready', 'active', 'left', 'removed'
);

CREATE TABLE raids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kabanda_id uuid NOT NULL REFERENCES kabandas(id) ON DELETE RESTRICT,
  organizer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  navigator_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  scheduled_at timestamptz,
  state raid_state NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  started_at timestamptz,
  paused_at timestamptz,
  cancelled_at timestamptz,
  finalizing_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX raids_kabanda_actionable_idx ON raids (kabanda_id, state, scheduled_at, created_at);
CREATE UNIQUE INDEX raids_one_active_per_kabanda_idx
  ON raids (kabanda_id)
  WHERE state IN ('active', 'paused', 'finalizing');

CREATE TABLE raid_participants (
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state raid_participant_state NOT NULL,
  invited_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  ready_at timestamptz,
  active_from timestamptz,
  left_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (raid_id, user_id)
);

CREATE INDEX raid_participants_user_actionable_idx ON raid_participants (user_id, state, raid_id);

CREATE TABLE raid_readiness_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  navigator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  raid_version integer NOT NULL CHECK (raid_version > 0),
  app_mode text NOT NULL CHECK (app_mode IN ('browser', 'standalone')),
  location_permission text NOT NULL CHECK (
    location_permission IN ('granted', 'prompt', 'denied', 'unsupported', 'unknown')
  ),
  coordinate_measured_at timestamptz,
  accuracy_meters double precision CHECK (accuracy_meters IS NULL OR accuracy_meters >= 0),
  indexed_db_writable boolean NOT NULL,
  storage_available boolean,
  online boolean NOT NULL,
  measured_at timestamptz NOT NULL,
  blocker_codes text[] NOT NULL DEFAULT '{}',
  warning_codes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX raid_readiness_current_idx
  ON raid_readiness_reports (raid_id, navigator_user_id, raid_version, created_at DESC);

CREATE TABLE raid_command_receipts (
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_id text NOT NULL CHECK (char_length(operation_id) BETWEEN 8 AND 100),
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE RESTRICT,
  command text NOT NULL CHECK (char_length(command) BETWEEN 1 AND 40),
  request_fingerprint char(64) NOT NULL,
  expected_version integer,
  mutates_state boolean NOT NULL,
  from_state raid_state,
  resulting_state raid_state NOT NULL,
  resulting_version integer NOT NULL CHECK (resulting_version > 0),
  response_json jsonb NOT NULL CHECK (octet_length(response_json::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, operation_id)
);

CREATE UNIQUE INDEX raid_command_one_mutation_version_idx
  ON raid_command_receipts (raid_id, resulting_version) WHERE mutates_state;

CREATE INDEX raid_command_receipts_raid_audit_idx
  ON raid_command_receipts (raid_id, resulting_version, created_at);
