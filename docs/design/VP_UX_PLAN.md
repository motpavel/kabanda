# VP 2/9: UX plan and screen map

Issue: [#31](https://github.com/motpavel/kabanda/issues/31)

## Purpose

The design gate proves that an organizer and an ordinary participant can complete one shared ride
without product decisions being invented during production implementation. The artifact is a clickable
PWA prototype, not a collection of static presentation screens.

<design_plan>
Python RNG preflight, seed 97:
hero=Cinematic Center; font=Geist
components=Infinite Marquee, Inline Typography Images, Feedback Carousel
motion=Scroll Pinning, Card Stacking

Constraint adaptation:
- Cinematic Center applies only to the calm first-value/onboarding moment; product screens use a
  single-column utility hierarchy.
- Geist is retained.
- The approved logo may appear inline with onboarding typography. Continuous marquees and testimonial
  carousels are rejected because they harm outdoor readability and have no product job.
- Scroll pinning and decorative card stacking are rejected for the active-ride flow because issue #31
  explicitly requires a light functional screen without decorative GSAP. A sticky action area and short
  state transitions provide spatial continuity instead.

AIDA check: not applicable to a transactional product shell. The equivalent product sequence is
orientation -> current state -> one next action -> canonical feedback.

Hero math: onboarding title uses a full-width phone container and `clamp(2.25rem, 11vw, 3.25rem)`;
Russian copy is limited to three lines. There are no stamp icons or tag spam.

Density check: product UI is a one-column flow. The only two-column metric grid always contains four
cells (2 x 2), leaving no empty grid cell.

Label and button check: no numbered meta-labels. Primary buttons use white on coral with an independently
verified pressed state; secondary actions use graphite on a white surface.
</design_plan>

The `gpt-taste` landing-page mechanisms are intentionally narrowed where they conflict with the
owner-approved product constraints. Its anti-slop rules still govern typography width, contrast, spacing,
label quality and restraint.

## Roles and paths

### Organizer

```text
first value -> auth -> home -> create Kabanda -> create raid -> lobby
-> navigator readiness -> active ride -> check-in -> offline/photo recovery
-> finish with pending review -> canonical result -> next ride
```

### Participant

```text
invite deep link -> choose login/password -> join -> browser/install explanation
-> lobby -> active ride -> confirm check-in -> add photo -> canonical result -> history
-> home / Kabanda / map / profile
```

Both paths use the same canonical ride state. Browser/standalone capability differences alter available
actions, not the domain lifecycle. Only the organizer can finish the shared ride; an ordinary participant
can contribute check-ins and photos and inspect the canonical result.

## Prototype screens

| Screen | Product question answered | Primary action |
| --- | --- | --- |
| Entry / role | Which usability path is being tested? | Start chosen path |
| Invite / value | Why should the participant continue? | Choose login/password and join |
| Authentication | Can the participant return from another device? | Sign in with login/password |
| Magic-link return | Did auth preserve the invite? | Join Kabanda |
| Install guidance | Why and when does the navigator install? | Open installed PWA / continue in browser |
| Home | What is the one relevant next action? | Create or continue raid |
| Kabanda | Who is in the permanent group? | Create raid |
| Raid setup | Can an organizer prepare it in under a minute? | Create lobby |
| Lobby | Who is ready and who is navigator? | Check navigator readiness |
| Readiness | Are install, location, storage and network sufficient? | Start ride |
| Active ride | Is tracking truly fresh and what is next? | Close nearest point |
| GPS recovery | What stopped and how is it recovered? | Resume tracking / hand off |
| Team check-in | Who is present and what will be credited? | Confirm participants |
| Photo draft | Is the file local or accepted? | Add to ride |
| Offline center | Which operations are local, sending, accepted or blocked? | Retry when safe |
| Finish review | Are pending operations visible before cutoff? | Finish ride |
| Result | What canonical value did the group create? | Plan next ride |
| History | Can the result be found again without confusing stale cache? | Open ride |
| Map | Can a point still be understood without a live map provider? | Open point card |
| Point detail | Is this a catalogue view or an active-ride check-in? | Return to map |
| Profile | Which device settings and local data belong to this account? | Return home |

## State rules

- `Маршрут записывается` is rendered only for a fresh accepted location sample.
- Stale GPS always includes last freshness, an icon and a recovery action.
- A fresh active ride opens check-in directly; GPS recovery is a separate degraded-state path and resumes
  the active ride rather than impersonating a normal check-in.
- Offline does not block safe local capture; it never masquerades as server acceptance.
- An update available during an active ride is deferred and never forces reload.
- Finishing with pending operations first opens a review state; it does not silently discard or double count.
- Only the organizer flow contains the finish action.
- A point opened from the global map is read-only catalogue context; it cannot start a raid-scoped check-in.
- Logout clears the active local identity and blocks replay. Pending operations are available only after the
  same user signs in again.

## Prototype boundary

- Mock data only; no production mutations.
- No map provider or live geolocation is required to validate information hierarchy.
- No decorative animation or external analytics.
- Production components may reuse tokens and copy, but prototype state is not a trusted backend model.

## Review gates

1. Automated structural tests: valid state graph, at most one primary action, all canonical delivery labels.
2. Browser smoke at 390 px and phone landscape, keyboard navigation and reduced motion.
3. Exact-head read-only Loop review in `Кабанда Разработка`.
4. Physical walkthrough on iOS and Android.
5. Five short usability sessions using `USABILITY_SCRIPT.md`.
6. Explicit owner approval before production UI is considered fixed.
