# Map repeat-pan read path

Changes:
- Serve valid persisted PNGs from concurrent readonly IndexedDB transactions. Expiry cleanup and coarse (60-second) LRU touches run separately through the worker lifetime promise; repeated reads no longer rewrite the PNG or wait for transaction commit. Maintenance re-reads before touching and never resurrects evicted/replaced fragments.
- Keep unprocessed preparation candidates when movement aborts a warmup pass. Remove a candidate only after a non-aborted preparation attempt; the set remains bounded to 32.
- Selecting the active bottom tab no longer starts another navigation/view transition. This also makes the five-tap local diagnostics gesture usable without repeated transitions.

Validation: full PWA suite 778 tests / 132 files; typecheck; seven mobile Chromium/WebKit worker checks passed, with one existing WebKit offline-emulation skip. New regressions verify no PNG timestamp rewrite on a recent hit and resumption of preparation interrupted by movement.

Physical iPhone remains on an unidentified installed build: the diagnostics gesture did not expose the published panel, and the app showed an active recording of the 23 September free raid. The user was asked whether recording may be paused for an update and resumed afterwards. No recording was stopped. Do not equate these algorithmic fixes or desktop WebKit checks with verified physical-iPhone frame timing.
