ALTER TABLE kabandas
  ADD COLUMN cover_image text,
  ADD CONSTRAINT kabandas_cover_image_check CHECK (
    cover_image IS NULL OR (
      char_length(cover_image) <= 420000
      AND cover_image ~ '^data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}$'
    )
  );
