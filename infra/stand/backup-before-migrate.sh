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

connection_parts=()
while IFS= read -r -d '' part; do
  connection_parts+=("${part}")
done < <(node "$(dirname "${BASH_SOURCE[0]}")/libpq-connection.mjs")
test "${#connection_parts[@]}" -eq 5
export PGHOST="${connection_parts[0]}"
export PGPORT="${connection_parts[1]}"
export PGUSER="${connection_parts[2]}"
export PGPASSWORD="${connection_parts[3]}"
export PGDATABASE="${connection_parts[4]}"
export PGCONNECT_TIMEOUT=5
unset DATABASE_URL

# Connection secrets stay in the root operator environment, never in process arguments or logs.
pg_dump --format=custom --no-owner --no-privileges --file="${archive}"
pg_restore --list "${archive}" > "${listing}"
test -s "${archive}"
test -s "${listing}"
sha256sum "${archive}" > "${archive}.sha256"
printf 'build=%s\nexpected_migration=%s\ncreated_at=%s\n' \
  "${API_BUILD_ID}" "${EXPECTED_MIGRATION}" "${timestamp}" > "${marker}"

printf '%s\n' "${archive}"
