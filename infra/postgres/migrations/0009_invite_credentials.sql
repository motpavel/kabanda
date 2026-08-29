ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN username citext,
  ADD COLUMN password_hash text,
  ADD COLUMN identity_kind text NOT NULL DEFAULT 'verified'
    CHECK (identity_kind IN ('verified', 'invite'));

CREATE UNIQUE INDEX users_username_unique_idx
  ON users (username) WHERE username IS NOT NULL;

ALTER TABLE users ADD CONSTRAINT users_identity_credentials_check CHECK (
  (identity_kind = 'verified' AND email IS NOT NULL)
  OR
  (
    identity_kind = 'invite'
    AND email IS NULL
    AND username IS NOT NULL
    AND password_hash IS NOT NULL
  )
);
