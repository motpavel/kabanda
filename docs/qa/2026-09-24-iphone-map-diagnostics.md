# On-device map diagnostics

Five quick taps on the selected Map bottom tab toggle a local-only panel. It reports the app and controlling worker builds, cached-layer activation/fallback, SDK ready/total tiles, prepared object URL reuse, and opt-in foreground worker hit/miss/error response time. The last measurement is time from the latest bounds change to SDK readiness, not physical display latency or FPS. No coordinates, full URLs, account data, persistence or telemetry uploads are added.

Normal use adds no worker timing messages, polling, or panel. Closing stops polling; hiding/disposal removes the panel. It is intended to establish whether the iPhone is using the published layer before attempting further performance changes.

Validation: typecheck; 8 focused unit tests; 7 worker browser tests passed (one existing WebKit offline-emulation skip). Real Yandex SDK/worker WebKit harness verified five-tap activation, layer state, timing delivery and dismissal. Physical iPhone reproduction preceding this change showed blank strips on returning to a previously viewed area; a precise cause has not yet been established.
