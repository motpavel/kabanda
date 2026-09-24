# Prepared map images for repeat panning

The disk cache prevents repeated network downloads, but returning to a recently viewed region could still ask the worker for each PNG again. The cached Yandex layer now keeps a bounded reserve of decoded HTML images and stable object URLs. Once a fragment has been prepared, the layer gives the SDK its object URL instead of the service-worker URL. Preparation runs sequentially after 900 ms of settled view: up to 16 recently requested fragments, then four nearby edge fragments. No layer-wide update/repaint is forced.

The per-map reserve is limited to an estimated 24 MiB of RGBA plus compressed image bytes and 48 entries. Actual browser/GPU overhead may exceed the accounting estimate. Least-recently-used entries are evicted; URLs are revoked on eviction, expiry, hidden map/document, fallback and disposal. In-progress decoding cannot repopulate a disposed reserve. Entries expire after at most five minutes and never exceed the original persistent fragment lifetime, supplied by the worker's expiry header. Older workers without this header continue using the ordinary cached URL.

Validation:
- 776 unit tests across 132 files passed; typecheck passed. Four new tests cover prepared reuse without another fetch/decode, byte-budget eviction, disposal during decoding and expiration/older-worker compatibility.
- Worker browser suite: five passed, one existing physical-Safari offline-emulation skip.
- Real Yandex SDK/API in WebKit with an iPhone viewport: a displayed center fragment became a prepared object URL. In the same two-area movement scenario the initial return made two foreground worker reads versus nine before; prepared fragments bypassed those reads. URLs were unusable after disposal as expected.
- These are not physical iPhone timing measurements. The sampling harness waits 300 ms before checking tile readiness, so reported render durations must not be interpreted as sub-frame latency improvements. Safari remains free to discard native decoded buffers under memory pressure.

The provider remains Yandex. This reserves a small recent neighborhood, not an offscreen rendering of the entire city.
