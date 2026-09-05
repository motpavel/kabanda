ALTER TABLE raid_checkin_attempts ADD COLUMN repeat_visit boolean NOT NULL DEFAULT false;

-- Completion credit is still unique per person/point/raid. Visit events are a
-- separate history, so free-hunt repeats never inflate route completion.
CREATE TABLE raid_point_visit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_id uuid NOT NULL REFERENCES raid_point_credits(id) ON DELETE RESTRICT,
  evidence_attempt_id uuid NOT NULL REFERENCES raid_checkin_attempts(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('gps', 'organizer_attestation', 'claim', 'media_fallback')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evidence_attempt_id, user_id)
);
CREATE INDEX raid_point_visit_events_credit_idx ON raid_point_visit_events (credit_id, created_at);
INSERT INTO raid_point_visit_events (credit_id, evidence_attempt_id, user_id, source, created_at)
SELECT id, evidence_attempt_id, user_id, source, created_at FROM raid_point_credits;
