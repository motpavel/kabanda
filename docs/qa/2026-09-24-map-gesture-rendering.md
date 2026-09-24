# Load/render tiles during mobile camera actions

On the physical iPhone the diagnostics panel confirmed app and worker `76df64886722` and the active cached Tiles API layer. A return pan showed 9 disk hits, 3 prepared images, no additional network miss, and 358 ms from the last bounds change to SDK readiness. Large blank strips remained visible during the gesture. This is SDK readiness, not measured physical frame latency.

The currently delivered Yandex JS API 2.1 mobile theme sets `layerLoadTilesInAction: false` and `groundPaneViewportMargin: 0`. Its layer's viewport handler explicitly skips tile viewport updates while an action is active when `loadTilesInAction` is false. Source was inspected from the SDK scripts actually loaded by the isolated real-provider harness.

Set `layerLoadTilesInAction: true` at map creation for the free map, raid map and route editor. Also set `loadTilesInAction: true` directly on the custom cached layer. No provider, credentials, request concurrency, cache budget or camera behavior is changed. These SDK options are present in the current implementation but not fully described on the public Layer reference; recheck behavior when upgrading the SDK.

Validation: 778 unit tests / 132 files and typecheck passed. A real-provider mobile Chromium touch-event comparison showed default 0 URL requests during the gesture / 3 after release, versus enabled 3 during / 0 after. Mouse dragging and programmatic camera transitions did not reproduce the mobile touch condition and are not accepted as validation of this fix. Physical post-release findings are recorded below.


Follow-up: the physical iPhone confirmed release `8d8539ca0882`, but fast pans still exposed blank areas. The SDK ground-pane factory reads its theme directly, so `groundPaneViewportMargin` in map options did not change the real viewport. Removed that ineffective option. The cached layer now uses a registered public `pane.MovablePane` with `margin: 256`, at the standard ground z-index; the map owns its lifetime. Real-provider WebKit verified viewport `[[-256,-256],[646,721]]` around a `390x465` map, with all 25 tiles ready. This validates the actual rendered border, not merely option assignment. The optional pane capability gracefully falls back to the normal pane when absent in older runtimes.


## Published release and physical iPhone verification

Release `93411a8629698525accb5b2888e6063a0c7b236d` was published. All 73 public files matched the built bytes. Clean mobile Chromium and WebKit verified a real 512 px tile miss followed by a cache hit. Typecheck and all 778 tests passed.

The physical iPhone PWA confirmed both app and worker `93411a862969`, with the cached Tiles API active and 30/30 ready tiles (previous default viewport had 12). A fast outward pan produced 7 disk hits / 5 misses and 895 ms SDK readiness; its return added 18 disk hits and no network misses, reaching readiness in 331 ms. Blank strips remained visible immediately after the fast gestures. These screenshots do not establish frame rate or a reliable before/after speed ratio.

A shorter 65 px synthesized drag still generated considerable inertia. The outward view was filled in the immediate screenshot; the return exposed a blank strip. Subsequent zoom-in preserved a scaled previous image, reached 30/30 readiness in 1134 ms, and added no network misses. Zoom-out reached readiness in 90 ms, with 8 prepared URLs reused cumulatively and no additional network misses. Readiness includes the offscreen reserve, not only visible pixels. These observations confirm working caching and reserve, but **do not establish that the reported blank flashes have been eliminated**.

No recording was paused or ended by this verification: opening the existing raid showed it already completed. No completed raid was restarted. Diagnostics were closed and the PWA was left on the ordinary map.
