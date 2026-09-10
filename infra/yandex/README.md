# Kabanda on Yandex Object Storage and Storage Relay

The static publisher and app-scoped Relay installer are executable. The installer validates its rendered candidate against the installed Relay schema before installation. Neither tool creates cloud resources or deploys by default.

## Static publication

`publish_static.py` accepts only bucket `kabanda` and an identified production build for the root origin `https://kabanda.website.yandexcloud.net`. Use Node/pnpm from the repository lockfile, then build with the reviewed full SHA:

```bash
GITHUB_SHA="$(git rev-parse HEAD)" VITE_APP_BASE=/ pnpm build
python3 infra/yandex/publish_static.py \
  --directory apps/pwa/dist \
  --release-sha "$(git rev-parse HEAD)"
```

The second command is a local dry-run. It does not import boto3, read credentials, create directories, or call Storage. The directory may contain only known public app files, bundled art and hashed Vite assets. Unexpected JSON, source maps, private files, symlinks and mismatched service-worker build markers fail before publication.

Source/build identity still requires a clean reviewed release and the same SHA supplied during build; the bundle's marker contains its first12 characters. Merely supplying a different CLI SHA does not relabel the build.

The publisher creates explicit `app`, `app/`, `lab` and `lab/` objects. Lab aliases use `lab/index.html`, preserving its separate installation manifest. Both manifests and their icon/start/scope references are validated. `index.html` is both website index and error document, so deep SPA links receive the shell. An unknown path can retain an HTTP404 status while serving that shell; this is not an API response.

HTML, aliases, manifests and mutable service-worker entry files use `Cache-Control: no-store`; hashed assets, Workbox runtime and exact build markers are immutable. Other public icons/art use `no-cache`. Content types are explicit, including extensionless HTML aliases. Private `/api` and `/relay` objects cannot be published. The client service worker must also exclude API/relay/private storage requests from navigation fallback and caching; the publisher does not rewrite generated worker code or cache any API response.

### Apply prerequisites

1. The owner has created/approved the static-only bucket `kabanda` in the intended folder. For Yandex website hosting, set its `anonymous_access_flags` to `read: true`, `list: true`, `config_read: false`; keep its bucket ACL private and grant no anonymous write/ACL-management permissions. Public object listing is required by the [Yandex hosting guide](https://yandex.cloud/en/docs/storage/operations/hosting/setup). These settings apply only to `kabanda`, never to either shared transport bucket. The default publisher sets each known object's ACL to `public-read`; the explicit `--bucket-public-read` mode below uses the verified bucket flags and leaves object ACLs private.
2. Verify its owner ID through authorized `get_bucket_acl`; supply that exact ID when populated. This Yandex account currently returns an empty owner ID. Use an authenticated account baseline or the verified console attestation described below. A public bucket ACL or unverified owner aborts before uploads. The separate Yandex read/list flags do not require a public bucket ACL; the [public-access documentation](https://yandex.cloud/en/docs/storage/operations/buckets/bucket-availability) shows flags alongside an empty ACL. A bucket ACL `READ` grant additionally exposes settings, so it is broader than the chosen flags.
3. The operator has a regular mode0600 credentials JSON containing `key_id` and `secret`. Keep it on the server; never include it in the release or command arguments. The verified shared Relay path is `/etc/whitelist-relay/credentials.json`; use it only when its permission scope covers the approved bucket. A separate Kabanda credential file is preferable when available.
4. The runtime Python has boto3. It uses only `https://storage.yandexcloud.net`, region `ru-central1`, SignatureV4 and bounded timeouts.
5. All required backend/relay functionality is healthy before replacing the public shell. An existing static frontend alone is not a completed migration.

When Yandex returns an empty ACL owner, first capture the authenticated account inventory in an existing private directory, preferably before bucket creation:

```bash
sudo python3 infra/yandex/publish_static.py \
  --credentials /etc/whitelist-relay/credentials.json \
  --capture-account-baseline /etc/kabanda/storage-account-baseline.json
```

This explicit preflight calls only `ListBuckets` and creates a new mode0600 local file. It never lists objects or creates a bucket. The file stores the endpoint, region, credential key-ID hash, account owner field and bucket names/creation times; it contains no access key or secret and is never overwritten. Both previously verified transport buckets must belong to the authenticated inventory. During publication, all baseline bucket identities must remain intact and `kabanda` must also appear in the authenticated inventory. A bucket absent from the baseline must have been created after that snapshot, with five minutes of clock skew allowed. A baseline that already contains the owned Kabanda bucket may be reused for future releases. Changing credentials/account requires a fresh verified baseline.

```bash
python3 infra/yandex/publish_static.py \
  --directory apps/pwa/dist \
  --release-sha "$KABANDA_RELEASE_SHA" \
  --credentials /etc/whitelist-relay/credentials.json \
  --account-baseline /etc/kabanda/storage-account-baseline.json \
  --snapshot-dir /var/backups/kabanda/static \
  --apply
```

Apply takes a local exclusive lock, snapshots mutable objects/ACLs and website configuration into a mode0600 file, verifies immutable collisions, uploads hashed assets before metadata and entry shells, and reads bytes/headers/ACLs back. Existing unrelated keys are never listed or modified. Bucket ACLs/policies are not changed. New immutable objects are retained on rollback so already-open clients can still load them.

After publication, verify anonymous website `/app`, the main manifest and a built asset return the expected content. Public listing of this static bucket is intentional; anonymous reads of bucket settings and writes must remain unavailable. The publisher does not inspect or modify Yandex control-plane flags, so these checks complement its S3 ACL verification.

On failure, mutable objects and website configuration are restored automatically. A timed-out PUT is treated as potentially committed. Rollback refuses to overwrite a concurrent writer's changed object. If rollback is incomplete the command fails with the protected snapshot path; inspect and reconcile that snapshot before retrying. This is not an atomic transaction across all S3 objects, so old and new frontend/backend releases must remain compatible during publication. Avoid simultaneous publishers on different hosts; the lock is local.

## Isolated Relay preparation

When the existing service key cannot call `ListBuckets`, do not treat an empty
Yandex ACL `Owner.ID` as proof of ownership. A signed `HeadBucket` plus an
operator's fresh verification in the authenticated Yandex console can be used
with `--console-ownership-proof /etc/kabanda/storage-console-ownership.json`.
The operator must actually create or inspect the bucket in folder
`b1gep85v7qqh3r08v1v4` before recording this private mode0600 attestation:

```json
{
  "version": 1,
  "verificationMethod": "yandex-console",
  "bucket": "kabanda",
  "folderId": "b1gep85v7qqh3r08v1v4",
  "endpoint": "https://storage.yandexcloud.net",
  "region": "ru-central1",
  "credentialKeyIdSha256": "sha256-of-the-server-side-key-id",
  "aclOwnerId": "",
  "publicAccess": {"read": true, "list": true, "configRead": false},
  "resourceUrl": "https://console.yandex.cloud/folders/b1gep85v7qqh3r08v1v4/storage/buckets/kabanda",
  "createdAt": "actual-creation-time-as-ISO-UTC",
  "verifiedAt": "actual-verification-time-as-ISO-UTC"
}
```

The proof expires after24 hours and is bound to the selected credential. Signed
bucket checks are still mandatory. This option does not create resources or
grant permissions, and placeholders above are not a usable proof.

For the bucket-scoped `storage.editor` service account, use the explicit public-flags mode; it needs no `PutObjectAcl` permission:

```bash
python3 infra/yandex/publish_static.py \
  --directory apps/pwa/dist \
  --release-sha "$KABANDA_RELEASE_SHA" \
  --credentials /etc/whitelist-relay/credentials.json \
  --console-ownership-proof /etc/kabanda/storage-console-ownership.json \
  --bucket-public-read \
  --snapshot-dir /var/backups/kabanda/static \
  --apply
```

This mode requires the exact boolean `publicAccess` attestation shown above, plus the usual ownership checks. It sends no object ACL header and never calls `PutObjectAcl`, including during rollback. Existing objects must have default-private ACLs: an ordinary overwrite can reset custom ACLs, so the publisher rejects those before any upload. It snapshots/checks ACLs and refuses to overwrite a concurrent ACL change during rollback. The original mode remains available for publications that explicitly manage object ACLs.

After each upload, the publisher also performs an anonymous GET of the exact `https://storage.yandexcloud.net/kabanda/<key>` and verifies the bytes. These requests contain no capability query, authentication or cookies, disable proxies and reject redirects. A denied or mismatched anonymous response fails publication and rolls back mutable files. This checks effective public object access; website routing, listing and closed configuration access still need the separate final checks above.

`templates/relay-config.template.json` has intentionally empty `storage`. Do not install it unchanged. `install_relay.py` copies the verified shared `storage` settings from `/etc/encounter-pwa/relay.json` into a private candidate with only the `kabanda` app. It changes `max_request_bytes` from the observed65536 to262144 only in the new Kabanda config. The target is `/etc/kabanda-relay/relay.json`, directory `root:whitelist-relay`0750, file0640. Permissions on the existing `/etc/kabanda` directory containing API secrets remain unchanged.

The proposed app contract is `POST /relay/v1/request` at `http://127.0.0.1:3099`, with no raw browser-selected backend URL. The encrypted inner request/session is authenticated by the Kabanda facade. Relay headers are telemetry, not proof of identity. No cookie/Authorization value is put in a public URL. The facade alone holds signing credentials for private blob capabilities.

The deployed CLI commands `validate --config` and `health --config --strict-permissions --quiet` were confirmed through read-only server inspection. Installed binaries are:

```text
/opt/storage-relay-kit/current/.venv/bin/python
/opt/storage-relay-kit/current/cli/relayctl.py
```

The rendered Kabanda candidate still must pass those checks during its actual apply; unit tests alone do not establish live compatibility.

Use its own `/var/lib/storage-relay-kit/kabanda.sqlite3` ledger. Preserve all existing entries and add `/etc/kabanda-relay/relay.json` exactly once to the colon-separated list in each file:

| File | Key |
| --- | --- |
| `/etc/storage-relay-kit/event-listener.env` | `STORAGE_RELAY_EVENT_CONFIGS` |
| `/etc/storage-relay-kit/bootstrap.env` | `STORAGE_RELAY_BOOTSTRAP_CONFIGS` |
| `/etc/storage-relay-kit/maintenance.env` | `STORAGE_RELAY_MAINTENANCE_CONFIGS` |

Run the installer dry-run on the server as an operator able to read the protected config/env files. It does not write files, inspect credential contents, call the network or run commands:

```bash
sudo python3 infra/yandex/install_relay.py
sudo python3 infra/yandex/install_relay.py \
  --expected-plan-hash "$KABANDA_RELAY_PLAN_HASH" \
  --backup-dir /var/backups/kabanda/relay \
  --apply
```

Use the exact `planHash` returned by the preceding dry-run. Apply locks `/run/lock/storage-relay-config.lock`, checks preimages, probes the loopback facade health endpoint and checks the existing listener. It creates a private snapshot/candidate, validates that candidate, checks preimages again, writes only the Kabanda config and appended env lists, and runs strict health as `whitelist-relay`. It then restarts only `storage-relay-event-listener.service` once, starts `storage-relay-bootstrap.service`, and verifies the published Kabanda bootstrap's identity, expiry, private inbox, public outbox and262144-byte upload policy.

Failure restores the touched files and restarts the old listener if a restart was attempted. Rollback refuses to overwrite concurrent edits and reports the protected snapshot when reconciliation is needed. Other operators must use the same lock or serialize changes. A rollback after bootstrap publication can leave an unused Kabanda bootstrap object until its expiry; it does not alter other app bootstraps. Reusing the shared listener can briefly interrupt other apps during its restart. Do not use the hardcoded Encounter installer unchanged, start a second polling gateway or create a duplicate ObjectCreate trigger.

## Object Storage transport policies

Existing public transport bucket: `mobile-whitelist-check-d4egfkd20koseppar0cp`. Existing private transport bucket: `mobile-whitelist-transport-d4egfkd20koseppar0cp`. New prefixes:

```text
transport/v1/apps/kabanda/bootstrap.json  public bootstrap
transport/v1/inbox/kabanda/              private request envelopes; ObjectCreate trigger
transport/v1/outbox/kabanda/             public encrypted replies
transport/v1/blobs/kabanda/              private encrypted large payloads; never inbox
```

The CORS templates grant only origin `https://kabanda.website.yandexcloud.net`. Merge by the new Kabanda rule IDs, preserving every other rule. Private transport needs POST for Relay inbox, PUT for signed blobs, GET/HEAD for signed retrieval. CORS is not permission to read objects: ACLs remain private and capabilities constrain key, method, expiry and size/content hash. Never print presigned forms/URLs or encryption keys.

Lifecycle templates affect only Kabanda outbox/blob prefixes and expire temporary objects after1 day, exceeding the10-minute SDK request recovery window. Finalize actual capability/session deadlines before applying. No lifecycle rule applies to the whole bucket or another application's prefix. Merge shared policies with preimage checks under a common lock; separate app IDs alone do not prevent lost updates from simultaneous bucket-wide PUTs.

The encrypted request target is at most192KiB including base64; the SDK envelope and metadata must fit the new Kabanda limit256KiB. Synchronous encrypted responses target at most96KiB. The installer verifies that the live presigned policy reflects the configured256KiB request limit. The historical Relay specification caps backend responses at256KiB; actual backend checks remain necessary. Large encrypted requests/responses use private blob capabilities under the non-trigger prefix. SDK0.3.1 accepts JSON/text/URLSearchParams, not raw binary; app encryption is an explicit Kabanda protocol, not a generic SDK feature.

## Local checks

`configure_storage.py --credentials /etc/kabanda/storage-publisher-credentials.json`
prints a read-only policy plan. Apply requires its exact `--expected-plan-hash`
and `--apply`; `--include-static` adds the new site's CORS rule after that bucket
exists. The default plan merges four Kabanda rules into the existing transport
buckets, preserving every unrelated rule. Backups and rollback are private.

```bash
python3 -m unittest discover -s infra/yandex -p 'test_*.py' -v
```

Tests cover routing/install metadata, static MIME/cache, no-network dry-runs, protected paths, account/bucket/listing guards, immutable collisions, config validation order, CAS, idempotence, failed-write rollback and concurrent-writer preservation. They use temporary local files and test doubles, and do not prove cloud permissions, deployed Relay behavior or mobile-network whitelist availability.
