# VP UX prototype evidence

Date: 2026-08-28

Prototype route: `/prototype`. Query parameters preserve the selected role and screen, for example:

```text
/prototype?role=organizer&screen=active
/prototype?role=participant&screen=invite
```

The top scenario panel belongs only to the prototype. It lets a reviewer jump to recovery states without
replaying the entire flow and is not part of production navigation.

## Local automated evidence

- `pnpm check`: pass.
- PWA suite: 16 tests pass, including five prototype graph/state tests.
- Production PWA build: pass; Geist Cyrillic is self-hosted and precached.
- Real-browser structural pass at 320 x 720 across 17 organizer and 16 participant states (33 total):
  - exactly one `.vp-primary-action` on every state;
  - no horizontal document overflow;
  - no primary-action overlap with another visible button, input or select.
- The same 33-state sweep at 844 x 390 with reduced motion has no horizontal overflow, disabled
  navigation targets or console errors; keyboard focus is visibly outlined.
- Semantic Playwright snapshots expose headings, labeled controls, status regions, alerts and both role paths.
- Bottom navigation routes to working home, history, map, Kabanda and profile states; it is not decorative.
- Role-boundary checks prove that only the organizer flow contains `finish`, while both roles pass through
  authentication.
- Console contains no application errors during the complete state sweep.
- White on action coral `#C93E32`: contrast ratio 4.98:1.
- Graphite `#232A35` on white: contrast ratio 14.44:1.
- Secondary text `#626B77` on white: contrast ratio 5.40:1.

## Visual checkpoints

- [Organizer entry](evidence/entry-organizer-390.png)
- [Participant invite](evidence/invite-participant-390.png)
- [Active ride](evidence/active-ride-390.png)
- [Offline delivery states](evidence/offline-states-390.png)
- [Canonical result](evidence/result-390.png)

## Still required for issue acceptance

- Physical iPhone and Android walkthrough.
- Five unaided usability sessions using `USABILITY_SCRIPT.md`.
- Recorded median normal check-in time.
- Explicit Pavel approval of the UX and tokens.

These items must not be inferred from desktop browser automation. Until they are recorded, issue #31
remains open and production UI is not treated as owner-approved.
