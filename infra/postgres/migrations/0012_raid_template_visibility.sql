ALTER TABLE raid_templates
  DROP CONSTRAINT raid_templates_scope_check;

ALTER TABLE raid_templates
  ADD CONSTRAINT raid_templates_scope_check
  CHECK (scope IN ('kabanda', 'all_authenticated'));

CREATE INDEX raid_templates_public_catalog_idx
  ON raid_templates (updated_at DESC, id DESC)
  WHERE scope = 'all_authenticated' AND archived_at IS NULL;
