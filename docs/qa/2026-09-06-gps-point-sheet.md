# GPS recovery and point check-in sheet

Base: `8d6731bd9b25de485282b08f7eb660604e9e83c2`. Frontend only; no migration, role or credit-policy changes.

## Cause and boundaries

The recorder treated every `watchPosition` error as terminal, called `clearWatch`, and released its writer fence. POSITION_UNAVAILABLE (including the iOS native message reported by the user) and TIMEOUT now preserve the subscription and fence. A subsequent durable sample clears the warning. Permission denial and storage/lease failures remain terminal; the writer-renewal timer cannot automatically restart a denied/failed subscription. Pause, hidden-page and ownership fences remain in place.

An independent short watch now supplies check-in/proximity evidence: ignore transient failures and samples older than five seconds, stop after the first fresh fix or a hard deadline, clear the subscription on every terminal path. No recorder cache, fabricated timestamp or invented position is used. Proximity distinguishes missing signal from denied permission and clears stale nearby eligibility after failed acquisition.

This fixes application error handling, not iOS background execution or hardware signal quality. A physical iPhone field test remains necessary. No production coordinates or live user raid were modified during QA.

Sources: [Apple locationUnknown](https://developer.apple.com/documentation/corelocation/clerror-swift.struct/code/locationunknown?language=objc), [W3C Geolocation](https://www.w3.org/TR/geolocation/).

## Design review

| Before | After | Why |
|---|---|---|
| Abrupt sheet toggle | Interruptible 260 ms transform transition on entry and exit | Preserve connection to the map |
| No dismissal gesture | Handle/header drag, distance/velocity dismissal, short-drag cancellation | Predictable mobile interaction |
| Repeated bordered participant cards | Flat avatar/name/status rows | One coherent check-in surface |
| Always-visible caption and upload fields | Optional photo disclosure, primary check-in action below | Keep the visit central |
| Raw native GPS error with recovery CTA | Quiet signal-waiting state that recovers on a fresh fix | Avoid turning a temporary fix failure into a stopped raid |

Native dialog remains mounted through exit and restores focus. Point-sheet drafts remain mounted after dismissal. Reduced-motion preference disables animated transitions. No celebratory effects were added. The map itself remains unchanged.

## Verification

- Workspace typecheck, production build and 206 PWA unit tests passed.
- Golden browser journey passed: create team, prepare/start raid, pause/resume, transient GPS errors 2/3/2 without dropping the watcher, automatic fresh recovery, permission denial across writer renewal, explicit recovery, check-in/photo, repeat visit, history count 2, flush/finish and completed result.
- Offline route/check-in/photo reload and exact-once replay passed; marker CSS regression passed.
- Swipe dismissal preserves the entered photo caption in the browser journey. Escape returns focus to the actions trigger.
- Manual browser check: sheet follows a 45 px drag, returns after a short slow gesture, closes after a 150 px swipe; mobile menu screenshot captured.
- Synthetic browser GPS and the repository's map adapter were used locally. These checks do not certify Yandex tile availability or background GPS behavior on a physical phone.

Deployment must compare the current exact base before swapping; preserve the previous release for rollback. Do not replace a user's active recording with a forced PWA reload.

## Follow-up: concise check-in card

User-requested visual refinement on top of `5e3b9f7ee537334c2d307ccc035bd14a33e82a89`:

- One light sage surface groups “Кого отмечаем на точке?” with the participant rows and GPS hint. No nested participant cards or secondary text under names.
- “Фото с остановки” is a full-width outlined disclosure with a camera icon and a 52 px minimum target. Its caption, upload and gallery remain optional, behind the same disclosure.
- “Пометить точку” is the single red primary action; repeat-visit actions use “Пометить ещё раз”. Removed the decorative sentence below the point title.
- GPS selection, organizer attestation, permission boundaries, submission, drafts, swipe behavior and offline replay are unchanged.

Verification: PWA typecheck, 206 unit tests and production build pass. Golden journey covers the new action labels, photo disclosure/draft preservation, check-in and repeat visit. Offline route/check-in/photo replay passes against the isolated local database. Browser artifacts use synthetic GPS, synthetic names and the map adapter, not live participants or Yandex tiles. This refinement has not been deployed.
