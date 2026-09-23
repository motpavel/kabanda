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
