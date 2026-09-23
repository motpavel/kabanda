-- Coordinates define a route point; places in forests and parks may have no postal address.
-- Relax validation without rewriting existing points.
ALTER TABLE raid_template_points DROP CONSTRAINT raid_template_points_address_check;
ALTER TABLE raid_template_points ADD CONSTRAINT raid_template_points_address_check
  CHECK (char_length(address) BETWEEN 0 AND 300);
