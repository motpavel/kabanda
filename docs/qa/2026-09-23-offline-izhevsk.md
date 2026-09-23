# Offline Izhevsk and map sheet recovery

## Implementation

- Free and raid maps use MapLibre with self-hosted Protomaps/OSM city data. Route creation retains its existing Yandex routing/geocoding implementation.
- One immutable 22,422,245-byte `.kmap` package contains the regional PMTiles, all 768 glyph files (three Noto Sans faces), 1×/2× sprites and licenses. Extent: longitude53.00–53.40, latitude56.70–57.00. Source date2026-09-23, native tile levels0–15; vectors overzoom to logical app zoom19. This does not invent extra source detail.
- First view reads byte ranges while the whole package saves in a separate public IndexedDB database. Exact length and SHA-256 precede atomic replacement. Version updates keep the previous complete city usable on failure. No API responses, user identities, GPS tracks or private imagery enter this public store.
- Manual retry, Save Data opt-in, quota failure, cancellation, and one map-renderer recovery per completed archive are handled. Browser storage persistence is requested; the browser can still reclaim site storage. Reopening a map after that requires downloading it again.
- The public `/app?offlineMap=1` screen works without authentication and independently registers the app service worker without activating a pending update. Session-unavailable screens link to it. Application JS, CSS and renderer worker are precached separately; the city archive is excluded from that cache to avoid duplication.
- Blank short taps dismiss the free-map point sheet; drags, pinches, controls and marker taps do not. The redundant unvisited label is removed from the sheet.

## Automated verification

- PWA:796tests in129files; TypeScript passed.
- Static publisher:29tests, including immutable binary city asset ordering and MIME.
- Real package integration uses a fetcher that throws for every request: verifies SHA/size, decodes a central-city MVT at all16native levels, reads all768glyphs and both sprite sizes with zero fetches.
- Store tests cover partial/checksum failures, quota exhaustion, aborted and superseded downloads, deduplication, offline reading and retention of the previous version.
- Adapter tests cover latitude/longitude and256px/512px zoom conversion, retained escaped marker layouts, pre-style-load route/casing layers, interrupted camera promises, cleanup and gestures.

## Mobile browser verification

CUA at320×740,375×812 and390×844, using real MapLibre and local synthetic raid/team fixtures (no production data writes):

- Empty-origin first opening downloads and displays the city; fixed a native `fetch` receiver bug found by this check. Reopening uses the saved city.
- A new page with navigator offline and all application fetches throwing renders the saved map, Russian street/POI labels, buildings and icons; repeated zoom and drag leave the request counter at0. This isolates cartography offline behavior; it is not a hardware airplane-mode test.
- Free map: selected point shows only the history's unvisited message; tapping clear map collapses the sheet.
- Raid map: recorded segments/casing and the gap's dashed connection render. A recenter flight shows an intermediate boar position then ends exactly at195,422 in a390×844map. Badge and route legend occupy separate rows.
-320px layout has document scrollWidth320 and a full-width map canvas.

A physical iPhone, native keyboard and mobile GPU/network performance were not available for this verification. Package geometry and labels are now local after the first completed download; this removes tile-network waits but does not guarantee a frame-rate measurement on every phone.

Sources and reproducible package build: `infra/maps/README.md`.
