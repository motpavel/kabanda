CREATE TABLE raid_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kabanda_id uuid NOT NULL REFERENCES kabandas(id) ON DELETE RESTRICT,
  scope text NOT NULL DEFAULT 'kabanda' CHECK (scope = 'kabanda'),
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  point_count smallint NOT NULL CHECK (point_count BETWEEN 2 AND 10),
  cover_bytes bytea NOT NULL,
  cover_content_type text NOT NULL CHECK (cover_content_type = 'image/jpeg'),
  cover_size_bytes integer NOT NULL CHECK (cover_size_bytes BETWEEN 1 AND 3145728),
  cover_width integer NOT NULL CHECK (cover_width BETWEEN 1 AND 2048),
  cover_height integer NOT NULL CHECK (cover_height BETWEEN 1 AND 2048),
  cover_sha256 char(64) NOT NULL CHECK (cover_sha256 ~ '^[a-f0-9]{64}$'),
  distance_method text NOT NULL CHECK (distance_method = 'straight_segments'),
  estimated_distance_meters integer NOT NULL CHECK (estimated_distance_meters >= 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cover_size_bytes = octet_length(cover_bytes))
);

CREATE INDEX raid_templates_kabanda_catalog_idx
  ON raid_templates (kabanda_id, updated_at DESC, id DESC)
  WHERE archived_at IS NULL;

CREATE INDEX raid_templates_creator_idx
  ON raid_templates (created_by_user_id, kabanda_id, updated_at DESC);

CREATE TABLE raid_template_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES raid_templates(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 9),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  address text NOT NULL CHECK (char_length(address) BETWEEN 1 AND 300),
  comment text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500),
  location geography(Point, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, position),
  CHECK (
    ST_Y(location::geometry) BETWEEN -90 AND 90
    AND ST_X(location::geometry) BETWEEN -180 AND 180
  )
);

CREATE INDEX raid_template_points_location_idx ON raid_template_points USING gist (location);

CREATE TABLE raid_template_receipts (
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_id text NOT NULL CHECK (char_length(operation_id) BETWEEN 8 AND 100),
  template_id uuid NOT NULL REFERENCES raid_templates(id) ON DELETE RESTRICT,
  command text NOT NULL CHECK (command = 'create-raid-template'),
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  resulting_version integer NOT NULL CHECK (resulting_version > 0),
  response_json jsonb NOT NULL CHECK (octet_length(response_json::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, operation_id),
  UNIQUE (template_id, resulting_version)
);

CREATE FUNCTION enforce_raid_template_point_count() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_template_id uuid;
  target_template_ids uuid[];
  expected_count integer;
  actual_count integer;
BEGIN
  IF TG_TABLE_NAME = 'raid_templates' THEN
    target_template_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'DELETE' THEN
    target_template_ids := ARRAY[OLD.template_id];
  ELSIF TG_OP = 'UPDATE' AND OLD.template_id IS DISTINCT FROM NEW.template_id THEN
    target_template_ids := ARRAY[OLD.template_id, NEW.template_id];
  ELSE
    target_template_ids := ARRAY[NEW.template_id];
  END IF;

  FOREACH target_template_id IN ARRAY target_template_ids LOOP
    SELECT point_count INTO expected_count FROM raid_templates WHERE id = target_template_id;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT count(*) INTO actual_count FROM raid_template_points
      WHERE template_id = target_template_id;
    IF actual_count <> expected_count THEN
      RAISE EXCEPTION 'raid template point count mismatch: expected %, found %',
        expected_count, actual_count
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER raid_templates_point_count_matches
  AFTER INSERT OR UPDATE OF point_count ON raid_templates
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_raid_template_point_count();

CREATE CONSTRAINT TRIGGER raid_template_points_count_matches
  AFTER INSERT OR UPDATE OR DELETE ON raid_template_points
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_raid_template_point_count();
