# Active raid marker regression

## Scope and cause

Fix the empty white pill-shaped point markers reported on the active free-raid
map. No API, location, check-in, database or service-worker behavior changed.

The `.kb-shell button` selector outranked `.raid-live-point`, replacing its
minimum height, padding, border and radius. Generic button hover/active rules
also displaced the geographic anchor. Scoped active-map selectors now preserve
the marker's geometry in all interaction states. Reduced-motion selectors were
updated to retain their override after the specificity change.

## Local verification

- PWA unit tests: 202 passed.
- Workspace typecheck and production build: passed (existing bundle-size warning).
- Golden raid and offline recovery: 2 passed. Golden includes the real map-layout
  button DOM through the synthetic Yandex runtime, check-in, grey marker history,
  explicit repeat visit and raid completion.
- Golden rerun and dedicated CSS regression: 2 passed. The CSS test uses the
  shipped stylesheet at 390 × 844 and exercises normal, hover and pressed states.
- Normal: 27 × 27, red 7px border, 50% radius, zero padding/min-height.
- Nearby: 35 × 35, red 9px border, 50% radius; pulse disabled with reduced motion.
- Visited: 27 × 27, grey 7px border; click still opens visit history.
- Geographic translation stays centered on hover/press.

These are local Chromium checks, not a claim of physical iPhone verification.
No production user's raid was opened, changed, completed or given synthetic GPS.
The existing PWA update gate should remain intact: do not force reload while the
user is recording a route.
