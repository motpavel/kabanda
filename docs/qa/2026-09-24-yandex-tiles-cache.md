# Optional Yandex Tiles API cache

Implemented for the ordinary map, active raid map and route editor. Production remains on the previously published standard Yandex map until a separate Tiles API key is supplied and real-provider validation is completed.

## Behavior

- Uses only the official Yandex Tiles API, preserving the existing Yandex SDK map instance, markers and camera.
- Switches to the cached layer only after the service worker confirms storage availability and a real PNG probe succeeds. API, quota and storage failures restore the standard Yandex layer.
- Stores public raster fragments in IndexedDB as ArrayBuffers (Blob persistence failed the WebKit harness). Maximum image payload is 100 MiB, with least-recently-used eviction and a seven-day lifetime. Expired entries are removed on use, periodic active-worker cleanup and writes; no background deletion can run while the app is closed.
- Reuses fragments across map screens and reloads. Keys include coordinates, zoom and pixel scale, not a user's identity or API key. Private application responses are never intercepted.
- After 900 ms without map movement, warms at most 12 nearby fragments around the viewport within the Izhevsk bounding box. Cancels speculative work when moving, hidden or disposed; skips it with data saving, slow connections or no network.
- Two concurrent upstream requests, starts at least 170 ms apart per device, foreground priority and shared in-flight requests. This is not an aggregate limiter across all users sharing the API key. HTTP 429 triggers cooldown and fallback.
- No complete city download and no promise of a cold offline launch: the Yandex SDK itself remains externally loaded, and browsers may evict local storage.

## Activation

Set the optional browser build variable `VITE_YANDEX_TILES_API_KEY` to a key for the separate Tiles API product. The normal JS API key is not a substitute. The worker is emitted and imported only when configured. The key is a public browser credential embedded in the build; apply provider-supported restrictions and monitor its quota. Do not commit real credentials.

Before release, validate the real key, browser CORS access, Yandex SDK custom-layer rendering, attribution, smooth interaction and fallback on mobile. The current tests use synthetic responses and do not establish those provider-specific properties. No new key has been created and no paid product has been purchased by this change.

## Validation

- PWA typecheck passed.
- 772 unit tests across 131 files passed, including 17 new tile-coordinate, worker and activation tests.
- Mobile Chromium / iPhone WebKit harness: five passed, one explicitly skipped. Both engines persisted decoded PNGs across reloads and served cached content with an unavailable upstream. Chromium also served cached fragments with browser networking disabled. WebKit's offline emulation failed before a worker response; physical Safari offline behavior remains unverified.
- Production builds passed both with a synthetic Tiles key and with the feature disabled. Neither test build was deployed.
- Harness requests never reach the real Tiles API and incur no API usage.

## References

- https://yandex.ru/maps-api/docs/tiles-api/index.html
- https://yandex.ru/maps-api/docs/tiles-api/request.html
- https://yandex.ru/maps-api/docs/tiles-api/quickstart.html
- https://yandex.ru/legal/maps_api/ru — temporary storage conditions must remain applicable; the configured seven-day TTL is below the stated 30-day ceiling, not permission for unrestricted bulk downloading.

## Live API follow-up, 24 September

The replacement key now returns HTTP 200, image/png and Access-Control-Allow-Origin: *. A local harness using the actual Yandex JS SDK, actual cache adapter and real Tiles API passed in mobile Chromium and iPhone-profile WebKit: the custom layer rendered, the marker and center were retained, a 512 px tile was decoded from cache, and the same tile remained a cache hit after page reload. Yandex attribution was visible in the WebKit screenshot. This supersedes the missing-key/CORS uncertainty above, but does not establish physical-device offline behavior or production integration.

The working key is stored outside the repository. Publication was not performed: both the direct deployment SSH connection and the configured jump-host connection closed before authentication. Production remains unchanged.

## Publication completed

SSH access recovered on the next retry. After fresh read-only verification of the exact bucket and public-access settings in the authenticated cloud console, release `09b9ec90a5b39594c87f3776bc3a049e2f771fe7` was published to `https://kabanda.website.yandexcloud.net/app` with the working Tiles key. All 73 public objects matched the local build byte-for-byte (directory aliases were verified through the storage endpoint).

Production checks in mobile Chromium and iPhone-profile WebKit both decoded a real 512 px tile: the first request was HTTP 200 / cache miss and the second HTTP 200 / cache hit. The server build configuration and private local public-build configuration retain the key for subsequent releases; no credential was committed. Rollback snapshot: `/var/backups/kabanda/kabanda-tiles-09b9ec9/static/kabanda-static-m1hzujxm.json`. The earlier SSH publication blocker is resolved.

## First-launch attachment follow-up

A clean production visit installed an activated worker but left the document uncontrolled (`navigator.serviceWorker.controller === null`). The previous publication checks explicitly reloaded, so they missed this first-launch gap. Enabled Workbox `clientsClaim` so activation attaches the installed worker to the current page; update activation still uses the existing recording-aware SKIP_WAITING gate. New production-build tests in mobile Chromium and iPhone-profile WebKit confirm automatic app registration, a controlled page and enabled tile storage without another document navigation or manual registration. Typecheck passed.

The user's existing in-app-browser tab was independently observed to retain the older `main-B3YR0vZ1.js` bundle even after an ordinary reload. This does not establish the version on the user's physical iPhone. The Yandex dashboard still displayed zero for the selected key despite confirmed successful live API requests; its reporting discrepancy is unresolved and is not evidence that all application map requests are cached.

First-launch fix published as `938aad205c08b410a3600872016d581418f10bb3`. All 73 public objects matched. Production mobile Chromium and iPhone-profile WebKit automatically acquired worker control on their first document, then returned a real 512 px PNG cache miss followed by a hit without manual worker registration or page reload. Rollback snapshot: `/var/backups/kabanda/kabanda-tiles-938aad2/static/kabanda-static-wjasb6qq.json`.
