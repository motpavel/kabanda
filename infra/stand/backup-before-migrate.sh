#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${API_BUILD_ID:?API_BUILD_ID is required}"
: "${EXPECTED_MIGRATION:?EXPECTED_MIGRATION is required}"

backup_directory="${KABANDA_BACKUP_DIR:-/var/backups/kabanda}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="${backup_directory}/${timestamp}-${API_BUILD_ID}.dump"
listing="${archive}.list"
marker="${archive}.marker"

umask 077
install -d -m 0700 "${backup_directory}"

# PGDATABASE accepts a libpq URI and keeps credentials out of the process arguments.
export PGDATABASE="${DATABASE_URL}"
pg_dump --format=custom --no-owner --no-privileges --file="${archive}"
pg_restore --list "${archive}" > "${listing}"
test -s "${archive}"
test -s "${listing}"
sha256sum "${archive}" > "${archive}.sha256"
printf 'build=%s\nexpected_migration=%s\ncreated_at=%s\n' \
  "${API_BUILD_ID}" "${EXPECTED_MIGRATION}" "${timestamp}" > "${marker}"

printf '%s\n' "${archive}"
