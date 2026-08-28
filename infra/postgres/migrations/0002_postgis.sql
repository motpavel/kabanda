CREATE EXTENSION IF NOT EXISTS postgis;

DO $$
DECLARE
  distance_meters double precision;
BEGIN
  SELECT ST_DistanceSphere(
    ST_SetSRID(ST_MakePoint(53.2027, 56.8527), 4326),
    ST_SetSRID(ST_MakePoint(53.2037, 56.8537), 4326)
  ) INTO distance_meters;

  IF distance_meters < 100 OR distance_meters > 140 THEN
    RAISE EXCEPTION 'PostGIS distance regression: expected 100–140m, got %', distance_meters;
  END IF;
END $$;
