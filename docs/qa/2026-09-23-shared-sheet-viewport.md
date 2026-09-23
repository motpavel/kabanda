# Shared fixed sheets and roomier route map

The route description uses two rows (74px instead of 102px). The map bleeds to both edges of its card and is 400–560px tall depending on screen height. Header, distance summary and ordered points retain their inner padding. The point count remains 2–10 because the request mentioning 20 was ambiguous and the clarification was unanswered.

## Sheet inventory

The tested route-point implementation is now shared from `src/components/sheets`:

- Route creation point sheet, retaining its existing frame, swipe expansion/dismissal and growing note.
- PointInfoSheet, covering global map point information and visited-point/history cards, including comments and photo captions.
- Active raid arrival/check-in sheet, including manual-review reasons and point materials.
- Active raid actions, finish and navigator surfaces.
- Kabanda rename/member/leadership dialogs, including the name input.
- New-raid chooser in the design prototype (no text fields).

Full-page route/raid descriptions, the fullscreen photo viewer and the orientation prompt are not bottom sheets and retain their existing presentation.

## Mechanism

One viewport/focus/gesture implementation handles all these surfaces. Ordinary sheets use fixed positioning at the visual viewport bottom; the route editor retains its frame adapter. Scrolling stays within sheet content, with boundary and non-overflowing forms blocked from propagating to the document. Only the top mounted sheet controls gestures; a reference-counted page lock prevents a closing sheet from unlocking a newer one. Closing restores the original page scroll/styles and removes listeners and the keyboard underlay.

The shared path includes iOS focus-pan prevention, keyboard-safe padding, a white underlay behind translucent keyboard accessories, rotation handling and an innerHeight fallback for webviews without VisualViewport. Inputs remain at least 16px and comments have neutral focus styling. Sheet dragging is deliberate on the handle; scrolling content no longer becomes a sheet drag at its top boundary.

Removed native scrollIntoView from comment-opening inside sheets; the shared controller reveals only the inner form. Standalone comments retain their ordinary page reveal. Existing drafts, comment submission, photo actions, role checks and API contracts are unchanged.

## Validation

- Full PWA suite: 700 tests in 119 files passed before final focused changes.
- Shared sheet/check-in suites after final focus-reveal changes: 148 tests in 21 files passed; shared viewport subset includes 29 cases covering gesture bounds, top-sheet ownership, nested unlock order, focus, rotation, missing VisualViewport and cleanup.
- PWA typecheck passed.
- Real PointInfoSheet/useSlideSheet components with synthetic children in a temporary local harness: history card and arrival sheet with focused comment at 390×350 had bottom=350 and root scroll=0; fields stayed above the footer. Switching arrival→native actions→close kept the lock until the last close. Rename form stayed inside horizontal viewport bounds; closing removed both lock and underlay.
- Actual point-materials styles: focused textarea outline none, neutral border, 16px text.
- Route editor: at 320px the map and card were both 296px wide and aligned, without horizontal overflow. At 390px the map was about 506px tall. Description measured 74px. The original route sheet remained bottom-aligned at 350px with focused note and zero root scroll.
- Local harness files are archived under output/route-creation-style and excluded from the production app.

These browser checks use desktop pointer input and resized viewports. A native iOS keyboard is unavailable locally; the user has confirmed the original route-point mechanism works well on their phone.
