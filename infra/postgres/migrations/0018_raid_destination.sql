ALTER TABLE raids
  ADD COLUMN destination_point_id uuid REFERENCES raid_point_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN destination_selected_at timestamptz;
