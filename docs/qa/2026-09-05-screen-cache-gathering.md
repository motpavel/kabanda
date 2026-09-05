# Screen cache, gathering and location recovery

Base: `71f9c721ec8ece2c7479e8b8a6a6f1edc804a493`.

## Changes

- Retain visited Home / Raids / Kabanda DOM per identity, including return from a raid.
- Revalidate server data quietly. Unmount hidden maps so GPS observers are not retained.
- Cache protected template covers in identity-scoped memory only (24 MiB, 64 entries), clear on sign-out / identity change / access denial. Never put API responses in SW cache.
- Precache public brand illustrations and fonts. Generated navigation glyphs use a single transparent atlas and CSS masks.
- Compact shared header, top cover, small raid title/date and navigator panel. Remove canonical-version panel and lobby jargon.
- Fresh high-accuracy watch, bounded 25-second acquisition, stale/coarse fix rejection, cleanup, explicit retry and permission instructions. Presence has a retry action too. Server readiness and 50 m presence rules are unchanged.

## Verification

- Workspace typecheck and production build: passed.
- PWA: 202 tests passed; API unit: 65 passed; PostgreSQL regression: 59 passed in a separate local test database.
- Golden + offline browser scenarios: 2 passed. Golden now denies GPS, checks that start remains unavailable, then restores permission with a fresh synthetic fix, retries, starts, checks in and completes the raid.
- Browser cache assertion: same image DOM node and zero cover requests across Kabanda → Raids; protected cover uses a blob URL.
- Local visual checks: 320 / 390 / 1280 px; compact gathering page, shared header and bottom navigation. Transition screenshots are captured after animation completes.
- Physical iPhone GPS/background behaviour is not validated by synthetic browser tests. The app cannot enable OS location settings itself.

## Image generation

Generated with imagegen for the user's explicit request; implementation uses CSS masks, not four large raster buttons.
Artifact: `apps/pwa/public/brand/kabanda-navigation-v1.png` (1254 × 1254, transparent PNG).
Brief: one evenly spaced 2×2 atlas of black monoline mobile navigation icons: house, folded map, complete bicycle, group of people; consistent visual weight, transparent background, no text or decoration, centered within quadrants. No external reference imagery.

## Deployment

No new database migration. Preserve migration `0016_raid_departure_options.sql` and all previously integrated functionality. Deploy only the combined exact commit after comparing current release with the base above. Keep the old release for rollback. Deployment status is tracked separately in the local release report; this document alone is not evidence of publication.
