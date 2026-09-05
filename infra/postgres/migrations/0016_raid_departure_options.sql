ALTER TABLE raids
  ADD COLUMN point_category text CHECK (point_category IN ('stores', 'attractions')),
  ADD COLUMN meeting_place text CHECK (char_length(meeting_place) <= 200);

ALTER TABLE raids ADD CONSTRAINT raids_route_or_category
  CHECK (route_template_id IS NULL OR point_category IS NULL);
