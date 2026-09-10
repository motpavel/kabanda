# Prepared launch sequence — 2026-09-10

No step in this document has been executed. Database transfer and configuration
transfer remain separate actions with their own reviewed mechanism.

Read-only verification on the destination:

- Image `kabanda-api:yandex-preflight` is
  `sha256:ace8eb2a92e3571bb56453096aa1856a3bdb28a63418e9ad54f6e8e4b2eff569`.
- All 72 Docker build inputs in `/var/tmp/kabanda-build-20260910` match committed
  source `3ea877e2f4d43b6b3004116056bf75a64d5bf16b` by SHA-256. There are no
  missing or mismatched inputs.
- API image uses `node`, Linux/amd64. The Sharp/font build check passed.
- Docker Compose is 5.5.0. Disk has approximately 5.0 GiB available.
- There are no containers. Ports 3098, 3099 and 54329 are not listening.
- `/etc/kabanda` already has the prepared key, S3 credential, session secret,
  PostgreSQL administrator password and application password files. The API RSA
  key and relay S3 JSON are UID/GID 1000 with mode 0400. Other secret files are
  root-owned and private. `api.env` and `compose.env` have not been created.

## Optional empty PostgreSQL bootstrap before transfer

The complete Compose file requires API variables and its private `api.env` even
when selecting only `postgres`. Do not create placeholder API secrets to bypass
that validation. Copy the reviewed `compose.postgres.yaml` into the release
checkout and use the isolated manifest below. It defines only the destination
PostgreSQL service, with the same `kabanda` project and `kabanda_postgres_data`
volume used by the complete stack. The commands contain only the password file
path; the password itself remains in its prepared root-owned 0400 file.

From the target release checkout:

```sh
sudo env KABANDA_POSTGRES_PASSWORD_FILE=/etc/kabanda/postgres-admin-password \
  docker compose --env-file /dev/null -f infra/yandex/compose.postgres.yaml config --quiet
sudo env KABANDA_POSTGRES_PASSWORD_FILE=/etc/kabanda/postgres-admin-password \
  docker compose --env-file /dev/null -f infra/yandex/compose.postgres.yaml up -d --wait --wait-timeout 120 postgres
sudo env KABANDA_POSTGRES_PASSWORD_FILE=/etc/kabanda/postgres-admin-password \
  docker compose --env-file /dev/null -f infra/yandex/compose.postgres.yaml exec -T postgres \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d kabanda -c 'SELECT current_database(), PostGIS_Version();'
```

This initializes only an empty destination database and the image's PostGIS
extensions. There is no API service in this manifest, no import command and no
source connection. Keep the default image identical when later using the full
Compose file; if pinning a PostGIS digest, use the same digest in both invocations.
Do not remove the data volume between bootstrap and full-stack startup.

The latest read-only measurement found 5.0 GiB of disk and 1471 MiB available
memory, with no containers running. PostgreSQL is limited to 512 MiB RAM and a
128 MiB shared-memory mount; the latter is part of the container's memory
accounting, not an additional reservation. Allow roughly 1–2 GiB of disk for the
PostGIS image download/extraction plus the empty database, then measure the
actual remaining space before any database restore. This is an estimate, not a
measured import capacity. The API remains stopped and adds no memory usage.

`pg_isready` checks final TCP availability, avoiding the entrypoint's temporary
Unix-socket server during initialization. The explicit SQL probe also confirms
PostGIS is installed. Neither check proves the application schema or transferred
data is present; the API's `/api/ready` checks that later.

## After the approved transfer

Place the separately approved source-configuration JSON at
`/etc/kabanda/source-config.json`, root-owned mode 0600. It contains string values
from the source environment: required `ALPHA_ACCESS_MODE`, `ALPHA_ACCESS_SECRET`,
`MEDIA_CAPABILITY_SECRET`, `SESSION_TTL_DAYS`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`;
optional SMTP auth/TLS settings, magic-link TTL, diagnostic flag and Nominatim URL.
It must preserve the original alpha/media secrets. `DATABASE_URL`, old origin,
and old static build paths are intentionally discarded by the preparer. The
preparer does not obtain this file or export any data from the source server.

Copy the reviewed Compose file and the two local helper scripts into the chosen
release checkout on the target. The original source-only Docker staging did not
include Compose/helper scripts. From that checkout, first run a dry preparation:

```sh
sudo python3 infra/yandex/prepare_runtime.py \
  --source-config-json /etc/kabanda/source-config.json \
  --app-origin https://kabanda.website.yandexcloud.net \
  --blob-bucket '<CONFIRMED_PRIVATE_BLOB_BUCKET>' \
  --build-id 3ea877e2f4d43b6b3004116056bf75a64d5bf16b \
  --image kabanda-api:yandex-preflight
```

Substitute the actually configured blob bucket. This emits only nonsecret
metadata and planned filenames. If `smtp_is_loopback` is true, confirm a working
destination SMTP service or supply its real configuration before enabling email
login. The old source server's local mail service is not moved by an env file.

After the dry preparation succeeds, repeat that same command with `--apply`.
It creates `/etc/kabanda/api.env` and `/etc/kabanda/compose.env` as root-owned 0600
files and refuses to overwrite existing files. It never starts containers or
transfers/restores a database. The destination app role is `kabanda_app`; its
password comes privately from `/etc/kabanda/database-app-password`.

```sh
sudo docker compose --env-file /etc/kabanda/compose.env -f infra/yandex/compose.yaml config --quiet
sudo docker compose --env-file /etc/kabanda/compose.env -f infra/yandex/compose.yaml up -d postgres
sudo docker compose --env-file /etc/kabanda/compose.env -f infra/yandex/compose.yaml exec -T postgres pg_isready -h 127.0.0.1 -U postgres -d kabanda
```

Only after the separately reviewed restore has populated the destination and
created the application role, check schema `0018_raid_destination.sql`, restore
counts and ownership. The expected API connection is strictly
`127.0.0.1:54329/kabanda`, using `kabanda_app`. The API startup guard rejects a
connection to another host/port/database. Do not start a second writer against
the source database or use the administrator role as the API login.

```sh
sudo docker compose --env-file /etc/kabanda/compose.env -f infra/yandex/compose.yaml up -d --no-deps api
sudo docker compose --env-file /etc/kabanda/compose.env -f infra/yandex/compose.yaml exec -T api node --input-type=module < infra/yandex/probe_runtime.mjs
sudo docker compose --env-file /etc/kabanda/compose.env -f infra/yandex/compose.yaml ps
```

The probe reads database readiness and performs an encrypted `/api/health`
round trip through the facade. It makes no account, photo or route changes and
prints no secrets. Compare its public-key SPKI fingerprint with the frontend's
pinned public key as a separate check. This local probe does not verify the
Object Storage trigger, signed blob CORS, frontend publication or mobile-network
access; those remain the subsequent end-to-end checks.
