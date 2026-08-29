# Kabanda design system

This file is the source of truth for the closed-VP interface. Page overrides belong in
`design-system/kabanda/pages/` and may narrow these rules, but must not silently change the
brand palette, status grammar, accessibility floor or one-primary-action rule.

## Direction

- Product character: urban, active, friendly and slightly unruly, never aggressive or childish.
- Interface: light, calm and useful outdoors. The logo may be expressive; product surfaces stay quiet.
- Architecture: installable mobile-first PWA, not a mock native application.
- Core viewport: 390 px portrait; minimum supported width: 320 px.
- One primary action per product state. Secondary actions remain visibly subordinate.
- No decorative GSAP in the active-ride flow. Motion only explains state and respects reduced motion.

## Brand asset

- Approved reference: `/brand/kabanda-logo-reference.png`.
- The asset is stored byte-for-byte from the owner-approved source.
- Use the full lockup on onboarding and the compact boar mark where space is constrained.
- Do not redraw, recolor, stretch or replace the boar.

## Color tokens

| Token | Value | Use |
| --- | --- | --- |
| `--vp-bg` | `#F7F7F5` | application background |
| `--vp-surface` | `#FFFFFF` | cards and sheets |
| `--vp-ink` | `#232A35` | primary text and structural icons |
| `--vp-muted` | `#626B77` | secondary text; verified for readable pairs |
| `--vp-border` | `#DDE1E5` | dividers and quiet borders |
| `--vp-brand` | `#F05A4A` | approved logo coral, route and large decorative accents |
| `--vp-accent` | `#C93E32` | accessible primary action and active text; 4.98:1 with white |
| `--vp-accent-pressed` | `#A93029` | pressed primary action |
| `--vp-success` | `#247456` | canonical acceptance |
| `--vp-warning` | `#9A5A13` | stale, local-only and degraded states |
| `--vp-danger` | `#B83E38` | destructive or failed state |
| `--vp-focus` | `#2768D8` | focus ring, distinct from brand/error |

Status must never rely on color alone. Every state combines an icon, a short label and recovery copy
when action is required.

## Typography

- Primary family: Geist with system sans-serif fallback. It follows the deterministic design preflight
  and remains neutral next to the expressive logo.
- Body: 16 px minimum, line height 1.5.
- Display: 32–44 px on phone, at most three lines.
- Screen title: 24–28 px, weight 650–720.
- Numeric metrics use tabular figures.
- Russian copy is direct and short. Brand jokes belong to game entities, not system controls.

## Geometry and spacing

- Spacing scale: 4, 8, 12, 16, 24, 32, 48 px.
- Screen gutter: 16 px on small phones, 20 px from 430 px, 24 px on tablet.
- Touch target: 48 px preferred, never below 44 px.
- Card radius: 20 px. Controls: 14–16 px. Pills are reserved for compact statuses.
- Card shadow: `0 10px 30px rgba(35, 42, 53, 0.07)`; no stacked heavy shadows.
- Fixed bottom actions include safe-area padding and content reserves matching their height.

## Interaction

- Tap feedback appears within 100 ms using color/opacity; it does not shift layout.
- Micro-transitions use 160–240 ms and transform/opacity only.
- Async actions disable the trigger and expose loading, success or recovery feedback.
- Errors explain what happened and the next action.
- Back restores the previous prototype/product state; deep links retain invite context.
- No interaction encourages phone use while the bicycle is moving.

## Canonical delivery-state language

| State | User-facing label | Meaning |
| --- | --- | --- |
| `local` | `Сохранено на телефоне` | safe locally, not yet canonical |
| `sending` | `Отправляем` | a delivery attempt is active |
| `accepted` | `Принято Кабандой` | server receipt received |
| `needs_action` | `Нужно действие` | automatic recovery stopped; user choice required |

Never call a local or queued operation completed.

## Navigation

- Top-level product navigation: `Главная`, `Рейды`, `Карта`, `Кабанда`, `Профиль`.
- Phone uses a labeled bottom navigation with at most five items.
- Active-raid mode replaces ordinary navigation with one focused ride shell and an explicit exit path.
- Prototype-only scenario controls are visually separated and are not production navigation.

## Accessibility and quality floor

- WCAG AA contrast for text and meaningful controls.
- Visible `:focus-visible` ring; keyboard and screen-reader order follows the visual flow.
- Semantic buttons, headings, labels, status and alert regions.
- SVG icons from one 2 px rounded-stroke language; no emoji as structural icons.
- Reduced motion removes nonessential transitions.
- Dynamic text may wrap; critical values are not clipped.
- Map information has a text/list alternative.
- Verify 320, 375, 390, 430 and 768 px widths, plus phone landscape.

## Anti-patterns

- No glass dashboard, neon game UI, sci-fi chrome or childlike mascot treatment.
- No wall of badges, competing primary buttons or icon-only navigation.
- No raw coordinates, fake GPS precision or native-only promises.
- No broad runtime cache for private API/media.
- No continuous marquees, scroll pinning or decorative card stacking in functional flows.
- No hidden install, offline, update or permission failure state.
