# Yandex map lifetime and startup

The ordinary map now remains mounted after its first visit, including switching tabs, opening the list and waiting for an empty attraction category to load. Only one ordinary map is retained per current workspace; changing team or identity still destroys it. Returning resizes the map and refreshes the viewer marker without replacing its camera or underlying SDK instance.

Inactive maps skip marker updates and nearby-history prefetch. Point sheets close on leaving the map tab and their history consumers unmount. Pending location callbacks are invalidated when the map is hidden; an old callback cannot move the retained map on return. Browser background/foreground transitions also suspend and resume location handling.

The authenticated home screen schedules the shared Yandex SDK after 1.5 seconds and during idle time where supported. It skips data-saving and 2G connections, hidden/offline documents, and cancels scheduled work on navigation. It does not construct a hidden map or request geolocation. A failed background SDK initialization remains retryable when opening the map.

Raid maps initialize at already available viewer coordinates, or route geometry, instead of first constructing the city-wide default view. Completed rides preserve the route overview even when viewer coordinates are available. Data arriving during SDK startup is included in the initial viewport.

## Validation

- Full PWA suite: 754 tests passed before adding the SDK retry regression; the additional retry case and all eight existing loader/warmup tests passed afterwards.
- TypeScript and production build passed.
- 22 browser checks passed across Chromium and WebKit, covering screen continuity and completed-route visibility. Map-specific scenarios use a 390px viewport; WebKit uses the iPhone 13 device profile.
- Instrumented browser checks confirm one map creation and zero destructions across tab/list/category transitions, and destruction on changing teams. Late hidden-map geolocation and closing the point sheet are covered.
- Browser map tests use a Yandex mock. They verify application lifecycle, not real tile bandwidth or physical iPhone frame rate. Those measurements remain outstanding.

## Remaining dependency

Persistent caching of Yandex basemap fragments and city/route preloading are not enabled by this patch. The inspected local configuration and production source configuration contain only `VITE_YANDEX_MAPS_API_KEY`; no Tiles API configuration was found. Tiles API access and its key are required before implementing and validating the separate fragment-cache prototype. The user was asked about that access while independent optimizations proceeded.

The provider remains Yandex JavaScript API 2.1. No city download, alternative map provider, private-cache deletion, API/database change or claim of full offline availability is part of this patch.
