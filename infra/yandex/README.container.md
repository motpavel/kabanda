# Kabanda API and PostgreSQL on the existing Yandex VM

This scaffold builds and runs a separate `kabanda` Compose project. It does not
copy a database, run migrations automatically, configure the existing Storage
Relay listener, or publish the frontend. Those are separate cutover steps.

The API uses the Linux host network and binds only to `127.0.0.1:3098` and
`127.0.0.1:3099`. This preserves the API's loopback proxy checks and allows the
existing host relay listener to reach the facade. PostgreSQL has a separate
container/network and exposes only `127.0.0.1:54329`. Its named volume is
`kabanda_postgres_data`. Confirm those three ports and that volume name are free
before the initial launch. Host networking here requires a Linux Docker host.

## Images and build

The defaults are the official Node `22-bookworm-slim` image and the PostGIS
project's `postgis/postgis:16-3.5`, which supports PostgreSQL 16 and uses
`/var/lib/postgresql/data`. PostGIS publishes this tag for `linux/amd64`; the
Compose services explicitly select that platform. For a repeatable release,
resolve and record the two image digests and set `KABANDA_NODE_IMAGE` and
`KABANDA_POSTGIS_IMAGE` to their `name@sha256:...` references before the build.
Sources: [Node image tags](https://hub.docker.com/_/node),
[PostGIS image versions](https://github.com/postgis/docker-postgis).

`Dockerfile.api` uses pnpm **11.19.0**, the committed frozen lockfile, all workspace
manifests, and the committed `motpavel-storage-relay-web-0.3.1.tgz`. Only the API
workspace and its dependencies are installed. A separate production stage runs
`pnpm install --prod --frozen-lockfile`; the final image preserves its
workspace-relative `node_modules` links and includes the built API. This follows
pnpm's [separate production dependencies recipe](https://pnpm.io/docker).
The first Linux build showed that `pnpm deploy --legacy --offline` tries to
resolve missing registry metadata despite the existing install, so this image
uses the frozen production install directly.

Sharp and its optional Linux binaries are installed during the Linux build.
Developer `node_modules`, `.env`, keys, dumps and other local output are excluded
by `Dockerfile.api.dockerignore`. The image includes the two share-card brand
assets, DejaVu fonts, migrations, and point-import CSV files at the paths used by
the built API. The image build runs a Sharp Cyrillic text-rendering check.

## Private configuration

Prepare a private directory outside the checkout, for example `/etc/kabanda`,
owned by root with mode `0700`. None of the files below belongs in Git or the
Docker build context.

Create a root-owned `compose.env` with mode `0600` containing these required
variables. Values below describe the fields; they are not usable credentials:

| Variable | Value |
| --- | --- |
| `KABANDA_API_IMAGE` | Unique release tag, for example `kabanda-api:<full-commit>` |
| `KABANDA_API_ENV_FILE` | Absolute path to the private API environment file |
| `KABANDA_DATABASE_URL` | Destination app-role URL `postgresql://<app-role>:<URL-encoded-password>@127.0.0.1:54329/kabanda` |
| `KABANDA_POSTGRES_PASSWORD_FILE` | Absolute path to the PostgreSQL administrator password file |
| `KABANDA_RELAY_PRIVATE_KEY_FILE` | Absolute path to the relay PKCS#8 private RSA key |
| `KABANDA_RELAY_S3_CREDENTIALS_FILE` | Absolute path to S3 JSON containing `key_id` and `secret` |

The API environment file must contain the production `APP_ORIGIN`, `API_BUILD_ID`,
`EXPECTED_MIGRATION`, closed-alpha configuration, SMTP configuration,
`MEDIA_CAPABILITY_SECRET`, `SESSION_TTL_DAYS`, `RELAY_SESSION_SECRET`, and
`RELAY_BLOB_BUCKET`. Preserve the source alpha/media secrets when restoring its
database. The new relay session secret must contain at least 32 random
characters. Compose supplies the fixed API/relay ports, loopback trust, and
container paths for secret files. It overrides any `DATABASE_URL` in the API
environment file with the explicitly configured destination URL and rejects a
startup URL outside `127.0.0.1:54329/kabanda`.
The container command also removes an inherited `PWA_DIST_DIR`: this deployment
serves the frontend from Object Storage and does not include an old stand's
frontend build directory. Configure SMTP for the destination host; copying an old
loopback SMTP address does not move that mail service.

Use Compose-compatible environment syntax. Single-quote values containing `$`
to preserve their literal contents; URL-encode the password in a database URL.
The API environment file stays root-owned `0600`: Docker reads it before starting
the container. Do not print `docker compose config` without `--quiet`, since the
resolved configuration contains environment credentials.

The runtime runs as numeric UID/GID **1000:1000** with a read-only root filesystem.
Only `/tmp` is writable. The RSA key and S3 JSON are individual read-only bind
mounts and must be readable by UID 1000 inside the container. In the private
root-owned host directory, install those two files with owner `1000:1000` and
mode `0400`; the directory remains `0700` root-owned. Keep the PostgreSQL password
file root-owned `0400`: the database entrypoint reads it before switching users.
Do not rely on Compose `uid`/`mode` attributes to change host bind-file permissions.

The PostgreSQL container bootstraps only the administrator and an empty `kabanda`
database. Create/restore the dedicated application role and restore the approved
database snapshot separately before starting the API. The API should use that
application role, not the PostgreSQL administrator. No password has a default.
Initialization explicitly uses UTF8 and `C.UTF-8` to match the source database.
Create any rehearsal database from `template0` with the same encoding and locale.

## Review, build and cutover commands

Run from the repository root on the target Linux VM with Docker Compose v2
supporting required env files and bind `create_host_path: false`:

```sh
docker compose --env-file /etc/kabanda/compose.env -f infra/yandex/compose.yaml config --quiet
docker compose --env-file /etc/kabanda/compose.env -f infra/yandex/compose.yaml build api
```

`config --quiet` checks the manifest without printing secret values; `build api`
does not start services or change database contents. Missing required paths fail
rather than silently creating empty directories.

After the restore and cutover steps have been prepared, start the destination
database first, restore and verify it, then start the API:

```sh
docker compose --env-file /etc/kabanda/compose.env -f infra/yandex/compose.yaml up -d postgres
# Perform the separately reviewed role/restore/migration checks here.
docker compose --env-file /etc/kabanda/compose.env -f infra/yandex/compose.yaml up -d --no-deps api
docker compose --env-file /etc/kabanda/compose.env -f infra/yandex/compose.yaml ps
```

Do not run `down -v` during an update or rollback: the named PostgreSQL volume
contains the application data. API rollback selects the previous immutable image
tag and recreates only the `api` service. The startup command deliberately does
not run migrations; schema changes and database compatibility are reviewed before
the image is switched.

API health checks exercise both database readiness through the original API and
the facade health route. They do not replace an encrypted round-trip test: check
the deployed public/private key pair, login, map reads, a GPS batch, an authorized
photo upload/download, and the signed Object Storage CORS configuration before
publishing the frontend. Encrypted upload/response prefixes also need the
separately configured Object Storage lifecycle cleanup.

## Validation status

The manifest was parsed and its required-secret/loopback/read-only settings were
checked locally. The API typecheck and 15 relay regression tests pass.

On 2026-09-10, the full Linux/amd64 image build completed on the target Yandex VM
as `kabanda-api:yandex-preflight` (image prefix `ace8eb2a92e3`). The production
frozen install and Sharp Cyrillic text rendering passed. Node base digest:
`sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`.
This build used source-only staging at `/var/tmp/kabanda-build-20260910` and did
not start the API or PostgreSQL services. Database restore, runtime secret-file
access and encrypted end-to-end checks remain separate cutover validation.

The VM's Docker 29.1.3 did not have Buildx, so the successful command was plain
`docker build -f infra/yandex/Dockerfile.api -t kabanda-api:yandex-preflight .`.
It must not include the Buildx-only `--progress` option on that installation.
