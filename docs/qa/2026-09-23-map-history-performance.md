# Map and point-history performance — 2026-09-23

## Behavior

- A raid point sheet immediately renders the known current-raid visit status. Red current-raid points do not imply empty all-time history. History arrives independently, with a small pending label instead of a skeleton when a known summary exists. Free-map sheets already have a projected summary and use the same compact loading presentation.
- Nearby summary history uses the existing identity/team/source-point resource and persistent cache. At most three nearest points (selected point/destination first) enter a shared serial queue after 1.5 seconds; the free map additionally waits for a settled viewport. No participant pages or photos are prefetched. Offline, background, save-data, 2G/3G and low-downlink contexts skip speculative reads. Visibility/online/connection changes can resume warming. Obsolete queued work is dropped, while an already-running shared read remains available to an opened sheet.
- Confirmed remote visit signature changes invalidate only existing matching histories, including participant windows; the initial live baseline and GPS changes do not invalidate caches. Cached empty history does not override a known positive current-raid visit.
- Both maps retain SDK placemarks/layouts and update only changed fields. Raid route geometry is reused on empty change-feed pages; future sample eligibility, corrections, reset and clock rollback still rebuild it.
- Explicit centering uses a 650ms SDK pan, preserving final zoom. GPS frame following waits for centering/zoom completion. Reduced-motion preferences are respected. Resize observers no longer issue competing immediate camera resets.

## Validation

- Full PWA suite: **737 tests / 125 files passed**.
- TypeScript project check passed.
- Meaningful regressions: 500 unchanged placemarks cause zero extra SDK additions/removals/property/coordinate updates; a 6,000-point unchanged route preserves geometry references; future-fix/time/reset boundaries; camera follow/zoom/interruption/reduced motion; shared warmup/foreground request; scope-specific invalidation; known raid status versus historical visitors.
- CUA browser test with the real Yandex SDK and real RaidRouteMap in a local fixture: displaced boar center moved through (919,105), (865,155), then exact map center (640,360). Zoom remained operational while following. Opening the point showed current-raid status immediately and the quiet history label, no skeleton.
- CUA test of the real ordinary-map component with fixture geolocation/read data: all 177 catalogue markers displayed; first settled viewport requested exactly three history summaries; after panning to another area the count reached six and stayed six on return. Boar moved through intermediate positions and ended at (633,360), matching the map center (632.5,360).
- At mobile width390px, opening a point rendered its sheet/history without a skeleton; closing and reopening retained the same history request count (7).
- Fixtures exist only under untracked output; no production visits, route recordings or comments created during QA.

## Limits

Browser QA used desktop Chromium, including actual map tiles, with synthetic geolocation. Physical iPhone frame timing and real mobile network tile delivery were not measured. These changes remove application-side marker/geometry/camera churn; they do not cache third-party map tiles or promise faster tile delivery from the provider.

## Yandex retained; free-map sheet follow-up

Yandex remains the provider for normal, raid and route-editor maps. The alternative city-package implementation was withdrawn; no PMTiles/Protomaps dependency, automatic city download or public alternate-map route is in the shipped application. Startup releases only the abandoned public `kabanda-city-map` database; private caches are untouched.

Free-map short blank taps now dismiss the point sheet while drag/pinch/marker/control gestures remain distinct. The redundant unvisited line above point history is removed. The updated PWA suite passes745tests in127files; TypeScript passes. Mobile390px QA uses the actual Yandex SDK with synthetic local team/point data.
