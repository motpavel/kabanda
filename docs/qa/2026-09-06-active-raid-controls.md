# Active raid controls — mobile UX pass

## Design intent

Preserve the existing React/Vite PWA, recording state machine and server commands.
The map is the primary surface. Secondary actions open one compact native dialog;
finishing is a separate confirmation step, not a permanently expanded diagnostics
card. Red is the primary/destructive action accent, white is the surface and black
is the primary text. Controls use centered SVG glyphs within 44–46px targets.

## Fixed

- Misaligned text ellipsis replaced with a centered vertical SVG icon. Back,
  close, pause/play and map controls share the same icon geometry.
- Removed full-width framed close button and nested finish inventory from the
  action list. Dialog supports outside click, Escape, focus containment/return,
  constrained height, scrolling and reduced motion.
- Pause/resume remain server commands independently of GPS recovery status.
  Paused screen has one resume action; GPS recovery is only offered to the active
  navigator. The misleading proximity/check-in overlay is hidden while paused.
- Menu and check-in/history sheets no longer appear on top of each other.
- Finish queue counts are shown only when needed; offline/partial-result
  safeguards and operation replay remain in the original finish implementation.
- Check-in CTA no longer sticks over the photo form. Collapsing handle no longer
  inherits a visible button border; photo action and participant controls aligned.
- Hidden check-in panel stops claim/fallback polling on pause (previously 409
  every five seconds); state dependency restarts polling after resume. Local
  drafts remain mounted. Golden regression spans one full polling interval.

## Verification

- Workspace typecheck and production build passed. Existing bundle-size warning.
- PWA unit tests: 202 passed.
- Golden raid, offline recovery and marker CSS regression: 3 passed (44.9s).
  Golden covers centered action icon, Escape/focus return, pause, single resume
  action, no recovery/arrival UI on pause, resume, actual check-in/repeat/history,
  finish confirmation, completion and next creation flow.
- Manual browser pass: Home, Kabanda and Raids at 320, 390, 768 and 1280px.
  No horizontal document overflow. Expanded schedule/note form also checked at
  320 and 390px. Realistic long synthetic account/team labels retained.
- Screenshots inspected for action dialog, pause, point confirmation, finishing,
  Home, Kabanda, raid list and expanded departure form.

Local test users and synthetic coordinates only. Yandex is mocked in the journey
tests: this verifies real app DOM/styles/interactions, not provider rendering or
physical iOS GPS. No live user's raid was changed, paused or completed. No schema
or API changes. The PWA update gate remains unchanged.

## Boundaries

This is a focused raid-journey and shared-layout pass, not exhaustive acceptance
of every admin/error route. Physical iPhone, screen reader and field GPS remain
outside this local browser pass. No dark theme exists to validate separately.
