CREATE TYPE alpha_access_grant_status AS ENUM ('active', 'revoked');

CREATE TABLE alpha_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_fingerprint char(64) NOT NULL UNIQUE,
  user_id uuid UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  status alpha_access_grant_status NOT NULL DEFAULT 'active',
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX alpha_access_grants_active_idx
  ON alpha_access_grants (id) WHERE status = 'active';

CREATE FUNCTION prevent_revoked_alpha_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  grant_status alpha_access_grant_status;
BEGIN
  IF NEW.removed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT status INTO grant_status
  FROM alpha_access_grants
  WHERE user_id = NEW.user_id
  FOR KEY SHARE;
  IF grant_status = 'revoked' THEN
    RAISE EXCEPTION 'closed-alpha access is revoked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kabanda_membership_requires_active_alpha_access
  BEFORE INSERT OR UPDATE OF user_id, removed_at ON kabanda_memberships
  FOR EACH ROW EXECUTE FUNCTION prevent_revoked_alpha_membership();

CREATE TABLE alpha_rollback_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kabanda_id uuid NOT NULL UNIQUE REFERENCES kabandas(id) ON DELETE RESTRICT,
  request_fingerprint char(64) NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  member_count integer NOT NULL CHECK (member_count BETWEEN 1 AND 20),
  grants_revoked integer NOT NULL CHECK (grants_revoked BETWEEN 0 AND 20),
  invites_revoked integer NOT NULL CHECK (invites_revoked >= 0),
  magic_links_invalidated integer NOT NULL CHECK (magic_links_invalidated >= 0),
  sessions_revoked integer NOT NULL CHECK (sessions_revoked >= 0),
  retained_results integer NOT NULL CHECK (retained_results >= 0),
  applied_at timestamptz NOT NULL DEFAULT now()
);
