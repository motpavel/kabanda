# On-device map diagnostics

Five quick taps on the selected Map bottom tab toggle a local-only panel. It reports the app and controlling worker builds, cached-layer activation/fallback, SDK ready/total tiles, prepared object URL reuse, and opt-in foreground worker hit/miss/error response time. The last measurement is time from the latest bounds change to SDK readiness, not physical display latency or FPS. No coordinates, full URLs, account data, persistence or telemetry uploads are added.

Normal use adds no worker timing messages, polling, or panel. Closing stops polling; hiding/disposal removes the panel. It is intended to establish whether the iPhone is using the published layer before attempting further performance changes.

Validation: typecheck; 8 focused unit tests; 7 worker browser tests passed (one existing WebKit offline-emulation skip). Real Yandex SDK/worker WebKit harness verified five-tap activation, layer state, timing delivery and dismissal. Physical iPhone reproduction preceding this change showed blank strips on returning to a previously viewed area; a precise cause has not yet been established.

Published frontend: `3e87dd796e7db58376f77fefdb1e55951af9eeef`; all 73 public objects matched the local build. Clean mobile Chromium/WebKit production checks both returned a real 512px PNG miss followed by a hit. Full PWA suite: 776 tests / 132 files passed after supplying the browser performance clock in the isolated worker VM fixture. No production change was needed for that fixture correction.

The physical iPhone was reconnected and its PWA closed for an update. Mirroring then lost the device and reported “iPhone not found”; the user was asked to reopen Kabanda and lock the device near the Mac. Diagnostic readings from the physical iPhone are still pending. Do not treat desktop WebKit timings as evidence that the observed blank strips are fixed.
