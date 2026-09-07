# Missed check-in recovery and display-only GPS smoothing

## Scope

- Base: `441be296fff885161d01b02db0863be24bb4b537`.
- A fresh GPS check-in refused as `too_far` is retained as a rejected receipt,
  not mandatory manual verification. The server radius and evidence are unchanged.
- A short, non-blocking Russian notice explains the refusal. The sheet closes;
  a subsequent nearby point and a fresh attempt on returning are available.
- Legacy IndexedDB `needs_action` / `too_far` receipts no longer count as required
  work in the point sheet, finish review or identity inventory. Nothing is deleted.
  Explicit fallback submissions and associated photo drafts remain recoverable.
- Actual manual-verification reasons use human-readable copy, not raw server codes.
- Map rendering alone softens small lateral oscillation (bounded to 3 m) and
  rounds corners within 2 m. Original GPS samples, mileage and credit logic are
  untouched. Segment endpoints, U-turns and sparse/gapped samples stay anchored.
  No routing API, road snapping, extrapolation or navigation has been added.

## Verification

- PWA: 221 unit tests; typecheck and production build.
- API: 65 unit tests passed; 60 DB-gated tests not run in the unit command.
- Store regressions: terminal refusal is not replayed; next point and return use
  fresh operation IDs; old-client receipts do not block finish/account work;
  existing photo bytes and fallback reservations are preserved.
- Track regressions: smaller jitter, immutable raw input, exact endpoints,
  bounded right turns, reversals, duplicate points, time gaps and sparse samples.
- Local browser regression uses an isolated synthetic identity, team and raid,
  the real local API/PostgreSQL and a Yandex rendering mock. The real API receives
  an out-of-radius fresh coordinate and refuses point A. Point B then succeeds.
  A legacy local receipt is restored, the page reloads, and a fresh check-in at A
  succeeds. Screenshots are emitted under the Playwright artifacts directory.
- Browser GPS is refreshed every second: fixed Chromium geolocation alone retains
  an old timestamp. This fixture behavior is not shipped to the app.
- Marker CSS regression verifies shape, anchor, colour, hover and pressed states.

## Deployment safety

No database migration. Check the common exact base before atomic publication;
retain the previous release/environment for rollback. Build on the server with
its real environment, never the local synthetic Yandex key or `KABANDA_E2E`.
The tunnel/domain and real raid data must not be changed by the test fixtures.
