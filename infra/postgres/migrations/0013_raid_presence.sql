ALTER TABLE raid_participants
  ADD COLUMN presence_override_at timestamptz,
  ADD COLUMN presence_override_by uuid REFERENCES users(id) ON DELETE RESTRICT;

CREATE TABLE raid_presence_reports (
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  location geography(Point, 4326) NOT NULL,
  captured_at timestamptz NOT NULL,
  accuracy_meters double precision NOT NULL CHECK (accuracy_meters BETWEEN 0 AND 50),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (raid_id, user_id),
  CHECK (expires_at > captured_at)
);

CREATE INDEX raid_presence_reports_expiry_idx
  ON raid_presence_reports (raid_id, expires_at);
