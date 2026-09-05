-- Existing raids remain free rides. The selected template is frozen into the
-- existing point snapshots when the draft is created, not read again at start.
ALTER TABLE raids ADD COLUMN route_template_id uuid REFERENCES raid_templates(id) ON DELETE RESTRICT;
ALTER TABLE raid_point_snapshots ALTER COLUMN collection_id DROP NOT NULL;
