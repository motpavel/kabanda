# Free-hunt catalogue, raid sheet and automatic GPS recovery

Base: `525eca3a8aba3116d432b2dfc80f779e53e6e5a3`.

## Reproduced causes

- Free attractions were snapshotted with `field_verified` only, although the city catalogue also contains `source_checked` attractions. A read-only preview diagnostic confirmed one raid snapshot versus 28 available attractions (27 source-checked and one field-verified). Resuming reused that incomplete snapshot; this was not a proximity or zoom filter.
- Raid actions used the shared slide-sheet behaviour but floated above the bottom edge with an X. They now attach to the edge, include safe-area padding, and dismiss with the handle, backdrop, swipe or Escape. Keyboard focus returns to the trigger.
- Keeping a native location watch alive was not sufficient when it stopped emitting callbacks. The new single-watch controller retries transient errors at 5/10/20/30-second intervals, capped at 30 seconds. A 20-second silent-watch watchdog also triggers recovery. Fresh positions reset backoff; stale and superseded callbacks are ignored.

## Scope and safety

- Migration `0017_free_hunt_catalogue.sql` only adds missing snapshots to active/paused free attractions hunts. Existing snapshot IDs, credits, route samples, completed history and template-based raids are not rewritten. New free hunts use both available verification states, not rejected/archived points. No visit is credited by the migration.
- Permission denial stops location requests. A permission-change listener and settings check resume automatically after access is granted. App code cannot enable system location permission itself.
- Pause, backgrounding and unmount cancel retries. Recovery never fabricates location samples or takes over another recording device automatically. Explicit device takeover and storage-error recovery remain separate controls.
- Mobile-design guidance kept one edge-attached surface, 44px grip target, safe-area spacing and the existing interruptible/reduced-motion slide behaviour; no nested modal or extra close button.

## Verification

- Workspace typecheck and production build pass.
- PWA: 211 unit tests; API: 65 unit tests.
- PostgreSQL: 44 tests on a separate disposable regression database, including idempotent repair, preserved old credit/snapshot, resumed distant point, category separation and immutable completed history.
- Golden Chromium journey passes: create team and free hunt, ready/start, actions sheet geometry and centred icon, backdrop/Escape/swipe, pause/resume, both nearby and distant markers, transient GPS failure, permission recovery without a GPS button, repeated visit, reload, finish and completed history.
- Offline recovery journey passes: track, check-in and photo survive reload and replay once.
- Check-in layout tested at 320px; actions sheet at 390×844. Manual in-app-browser inspection confirms edge attachment and outside-tap dismissal. Map tiles are mocked in local UI tests; no synthetic GPS is sent to the public environment.
- Test-harness corrections: wait for opening transitions before measuring/dragging; retain both points when replacing the fixture manifest; await asynchronous finish inventory before selecting its primary action.

Real iPhone GPS interruption/recovery and background limitations still require device testing. Browser fault injection is not a hardware GPS test.
