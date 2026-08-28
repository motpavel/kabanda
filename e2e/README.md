# Disposable E2E database

The E2E runner never creates, drops, or broadly cleans a database. A completed raid contains deliberately
immutable result rows, so pretending that row cleanup succeeded would weaken the production invariant.

Provision an external loopback database named exactly `kabanda_e2e`, set its database comment to
`kabanda-e2e-disposable-v1`, and expose it through `E2E_DATABASE_URL` using the separate login role
`kabanda_e2e` with a non-empty password. The role must have none of SUPERUSER, CREATEDB, CREATEROLE,
REPLICATION or BYPASSRLS. URL options are refused. The runner also requires externally supplied
`NODE_ENV=test`, `KABANDA_E2E=true` and UUID `E2E_RUN_ID`; it does not create these safety markers itself.
CI uses a dedicated disposable PostgreSQL service; destroying that service is the retention-zero cleanup.

`inspect-raid` is read-only and returns only aggregate counts after proving that the raid belongs to the exact
synthetic user derived from `E2E_RUN_ID`. It is used to prove strict route growth and stable, non-duplicated
check-in/media outcomes without exposing coordinates or media bytes.

For a local disposable database, create and mark it outside the runner, then destroy only that exact database
after verifying the marker from the `postgres` maintenance database:

```sql
SELECT datname, shobj_description(oid, 'pg_database')
FROM pg_database
WHERE datname = 'kabanda_e2e';
```

Do not reuse a shared or production-like database for this suite.
