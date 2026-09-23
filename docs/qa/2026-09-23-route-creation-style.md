# Route creation: shared Kabanda styling

The route editor now follows the raid preparation screen: a light gray canvas, centered brand navigation, white rounded sections, existing route artwork, readable field labels and red primary action. The three sections cover route details, ordered stops and visibility. Existing draft storage, cover processing, route calculation and creation payload are retained.

Point rows wrap long titles/addresses and put reorder/delete controls on a separate line. All point controls remain at least 44px wide; the mobile view has no hover effects. The point sheet has a labeled close button alongside existing Escape/swipe dismissal. Save errors and missing required fields receive focus and scroll into view, above the fixed action.

Validation:
- PWA typecheck and production build passed.
- Route feature tests: 30 passed in 8 files.
- Full PWA run: 658 passed, three transport integration tests timed out under concurrent build/dev load; all three passed when rerun alone. No transport code changed.
- Browser with local synthetic API and real map: checked 320, 390 and 1100px widths, no horizontal overflow; added two stops, confirmed/closed the sheet, reordered stops, uploaded a cover and changed visibility. Reload restored text, cover, stop order and visibility.
- Synthetic save failure and missing-title validation kept the draft, focused the message and placed it above the footer.
- Production user data was not used for local fixtures. A physical phone/keyboard was not tested. The product remains light-theme only; reduced-motion rules are preserved.
