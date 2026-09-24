# Load/render tiles during mobile camera actions

On the physical iPhone the diagnostics panel confirmed app and worker `76df64886722` and the active cached Tiles API layer. A return pan showed 9 disk hits, 3 prepared images, no additional network miss, and 358 ms from the last bounds change to SDK readiness. Large blank strips remained visible during the gesture. This is SDK readiness, not measured physical frame latency.

The currently delivered Yandex JS API 2.1 mobile theme sets `layerLoadTilesInAction: false` and `groundPaneViewportMargin: 0`. Its layer's viewport handler explicitly skips tile viewport updates while an action is active when `loadTilesInAction` is false. Source was inspected from the SDK scripts actually loaded by the isolated real-provider harness.

Set `layerLoadTilesInAction: true` and a modest 128 CSS-pixel ground-pane reserve at map creation for the free map, raid map and route editor. Also set `loadTilesInAction: true` directly on the custom cached layer. No provider, credentials, request concurrency, cache budget or camera behavior is changed. These SDK options are present in the current implementation but not fully described on the public Layer reference; recheck behavior when upgrading the SDK.

Validation: 778 unit tests / 132 files and typecheck passed. A real-provider mobile Chromium touch-event comparison showed default 0 URL requests during the gesture / 3 after release, versus enabled 3 during / 0 after. Mouse dragging and programmatic camera transitions did not reproduce the mobile touch condition and are not accepted as validation of this fix. Physical post-release verification follows separately.
