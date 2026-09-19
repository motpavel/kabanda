-- Additive field-sync protocol; no historical result or queued operation changes.
ALTER TABLE raid_point_credits DROP CONSTRAINT raid_point_credits_source_check;
ALTER TABLE raid_point_credits ADD CONSTRAINT raid_point_credits_source_check
  CHECK (source IN ('gps','organizer_attestation','claim','media_fallback','navigator_attestation'));
ALTER TABLE raid_point_visit_events DROP CONSTRAINT raid_point_visit_events_source_check;
ALTER TABLE raid_point_visit_events ADD CONSTRAINT raid_point_visit_events_source_check
  CHECK (source IN ('gps','organizer_attestation','claim','media_fallback','navigator_attestation'));
CREATE TABLE raid_navigator_attestations (
  attempt_id uuid PRIMARY KEY REFERENCES raid_checkin_attempts(id) ON DELETE RESTRICT,
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE RESTRICT,
  navigator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  participant_ids uuid[] NOT NULL CHECK (cardinality(participant_ids) BETWEEN 1 AND 20),
  previous_attempt_id uuid REFERENCES raid_checkin_attempts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE raid_sync_revisions (
  raid_id uuid PRIMARY KEY REFERENCES raids(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE FUNCTION bump_raid_sync_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME = 'raids' THEN target := NEW.id;
  ELSIF TG_TABLE_NAME = 'raid_point_visit_events' THEN
    IF TG_OP = 'DELETE' THEN SELECT raid_id INTO target FROM raid_point_credits WHERE id=OLD.credit_id;
    ELSE SELECT raid_id INTO target FROM raid_point_credits WHERE id=NEW.credit_id; END IF;
  ELSIF TG_OP = 'DELETE' THEN target := OLD.raid_id;
  ELSE target := NEW.raid_id; END IF;
  IF EXISTS(SELECT 1 FROM raids WHERE id=target) THEN
    INSERT INTO raid_sync_revisions(raid_id,revision) VALUES(target,1)
      ON CONFLICT(raid_id) DO UPDATE SET revision=raid_sync_revisions.revision+1;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER raids_sync_revision AFTER INSERT OR UPDATE ON raids FOR EACH ROW EXECUTE FUNCTION bump_raid_sync_revision();
CREATE TRIGGER raid_participants_sync_revision AFTER INSERT OR UPDATE OR DELETE ON raid_participants FOR EACH ROW EXECUTE FUNCTION bump_raid_sync_revision();
CREATE TRIGGER raid_credits_sync_revision AFTER INSERT OR UPDATE OR DELETE ON raid_point_credits FOR EACH ROW EXECUTE FUNCTION bump_raid_sync_revision();
CREATE TRIGGER raid_visits_sync_revision AFTER INSERT OR UPDATE OR DELETE ON raid_point_visit_events FOR EACH ROW EXECUTE FUNCTION bump_raid_sync_revision();
CREATE TRIGGER raid_claims_sync_revision AFTER INSERT OR UPDATE OR DELETE ON raid_checkin_claims FOR EACH ROW EXECUTE FUNCTION bump_raid_sync_revision();
CREATE TRIGGER raid_fallbacks_sync_revision AFTER INSERT OR UPDATE OR DELETE ON raid_checkin_fallbacks FOR EACH ROW EXECUTE FUNCTION bump_raid_sync_revision();
CREATE TRIGGER raid_presence_sync_revision AFTER INSERT OR UPDATE OR DELETE ON raid_presence_reports FOR EACH ROW EXECUTE FUNCTION bump_raid_sync_revision();
-- Materials never participate in scoring or immutable result aggregation.
CREATE TABLE raid_point_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  raid_id uuid NOT NULL REFERENCES raids(id) ON DELETE RESTRICT,
  point_snapshot_id uuid NOT NULL REFERENCES raid_point_snapshots(id) ON DELETE RESTRICT,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_id text NOT NULL CHECK(char_length(operation_id) BETWEEN 8 AND 100),
  kind text NOT NULL CHECK(kind IN ('comment','photo')),
  body text NOT NULL DEFAULT '' CHECK(char_length(body)<=2000),
  source_sha256 char(64), declared_type text CHECK(declared_type IN ('image/jpeg','image/png','image/webp')),
  declared_size integer CHECK(declared_size BETWEEN 1 AND 8388608),
  content_bytes bytea, width integer, height integer, ready boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(author_user_id,operation_id),
  CHECK((kind='comment' AND char_length(body)>0 AND ready AND content_bytes IS NULL)
    OR (kind='photo' AND source_sha256 IS NOT NULL AND declared_type IS NOT NULL AND declared_size IS NOT NULL
      AND (NOT ready OR (content_bytes IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL
        AND octet_length(content_bytes) BETWEEN 1 AND 3145728 AND width BETWEEN 1 AND 2048 AND height BETWEEN 1 AND 2048))))
);
CREATE INDEX raid_point_materials_list_idx ON raid_point_materials(raid_id,point_snapshot_id,ordinal DESC) WHERE ready;
CREATE TRIGGER raid_materials_sync_revision AFTER INSERT OR UPDATE OR DELETE ON raid_point_materials FOR EACH ROW EXECUTE FUNCTION bump_raid_sync_revision();
