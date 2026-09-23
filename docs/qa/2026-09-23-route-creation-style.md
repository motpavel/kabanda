# Route creation: shared Kabanda styling

The route editor now follows the raid preparation screen: a light gray canvas, centered brand navigation, white rounded sections, existing route artwork, readable field labels and red primary action. The three sections cover route details, ordered stops and visibility. Existing draft storage, cover processing, route calculation and creation payload are retained.

Point rows wrap long titles/addresses, show a red number at the left and a six-dot drag handle at the right. There is no action row; deletion remains inside the point sheet. Dragging near the viewport edge scrolls the list; the focused handle also supports keyboard arrows with position announcements. The handle remains 44px wide; the mobile view has no hover effects. Cards use the soft shadows of other Kabanda screens. The point sheet has a labeled close button alongside existing Escape/swipe dismissal. Save errors and missing required fields receive focus and scroll into view, above the fixed action.

Validation:
- PWA typecheck and production build passed.
- Route feature tests: 30 passed in 8 files.
- Full PWA run: 658 passed, three transport integration tests timed out under concurrent build/dev load; all three passed when rerun alone. No transport code changed.
- Numbered map pins now use one centered layout with an explicit tip anchor and hit area; verified against the real map.
- Browser with local synthetic API and real map: checked 320, 390 and 1100px widths, no horizontal overflow; added two stops, confirmed/closed the sheet, reordered stops by dragging the right handle and by keyboard, uploaded a cover and changed visibility. Reload restored text, cover, stop order and visibility.
- Synthetic save failure and missing-title validation kept the draft, focused the message and placed it above the footer.
- Production user data was not used for local fixtures. A physical phone/keyboard was not tested. The product remains light-theme only; reduced-motion rules are preserved.

## Interaction refinement

The point sheet is non-modal and its transparent frame passes pointer events to the map. Zoom/location controls stay above the sheet, and map clicks cannot create extra points until editing ends. Zoom level is preserved on selection. The ambiguous add-at-center button was removed. All icon-only buttons explicitly reset inherited padding and center their SVGs; card numbers align to the vertical center.

Reordering now previews positions using transforms, following the pointer while siblings move smoothly. The draft order commits on pointer release, with a settling animation; cancellation restores the order. Reduced-motion and keyboard reorder remain supported.

Addresses are optional across client, API contract and PostgreSQL (migration 0021 relaxes the length check without rewriting data). Missing-geocoder warnings no longer block confirmation. Placeholders are smaller, lighter and shorter. Removed the catalogue helper text. Drafts flush on page hide, except after successful submission.

Manual local browser check: three-point route including “Лесная поляна” with blank address, pan/zoom with sheet open, no accidental extra points, drag reorder, confirmation and reload. API tests cover empty/omitted address and coordinate validation; PostgreSQL test covers persistence and reload. Real touchscreen/pinch gestures require a phone; desktop pointer drag and zoom controls were exercised.

References: Google My Maps “Add places to your map” (direct placement and naming); Mapbox “Create a draggable Marker” (coordinate-based placement).

## Keyboard and address follow-up

The sheet uses VisualViewport height/offsetTop, freezes the page at its previous scroll position, and restores that position on close. Only the fields scroll; the header and confirmation actions stay in the sheet. Resize/scroll/focus listeners reveal the focused field inside that body and are removed on unmount. Inputs keep a neutral border without blue focus outlines.

Reverse geocoding now uses structured street and house-number fields. Missing streets yield an empty optional address. Existing editor drafts and legacy geocoder responses compact their address labels without districts, postcodes or country.

Validated keyboard geometry for overlay keyboards, iOS viewport panning, Android layout resizing, dismissal and pinch zoom. Browser checks at 390×420 and 390×300 showed the sheet bottom matching the visible height, focused fields above the fixed actions, document scroll unchanged, and no input outline/shadow. A physical phone's native keyboard was not available for testing.
