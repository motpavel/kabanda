# Route creation: shared Kabanda styling

The route editor now follows the raid preparation screen: a light gray canvas, centered brand navigation, white rounded sections, existing route artwork, readable field labels and red primary action. The three sections cover route details, ordered stops and visibility. Existing draft storage, cover processing, route calculation and creation payload are retained.

Point rows wrap long titles/addresses, show a red number at the left and a six-dot drag handle at the right. There is no action row; deletion remains inside the point sheet. Dragging near the viewport edge scrolls the list; the focused handle also supports keyboard arrows with position announcements. The handle remains 44px wide; the mobile view has no hover effects. Cards use the soft shadows of other Kabanda screens. The point sheet uses its upper handle for expansion/dismissal and closes on a background tap or Escape; it has no close icon. Save errors and missing required fields receive focus and scroll into view, above the fixed action.

Validation:
- PWA typecheck and production build passed.
- Route feature tests: 30 passed in 8 files.
- Full PWA run: 658 passed, three transport integration tests timed out under concurrent build/dev load; all three passed when rerun alone. No transport code changed.
- Numbered map pins now use one centered layout with an explicit tip anchor and hit area; verified against the real map.
- Browser with local synthetic API and real map: checked 320, 390 and 1100px widths, no horizontal overflow; added two stops, confirmed/closed the sheet, reordered stops by dragging the right handle and by keyboard, uploaded a cover and changed visibility. Reload restored text, cover, stop order and visibility.
- Synthetic save failure and missing-title validation kept the draft, focused the message and placed it above the footer.
- Production user data was not used for local fixtures. A physical phone/keyboard was not tested. The product remains light-theme only; reduced-motion rules are preserved.

## Interaction refinement

The point sheet is non-modal and its transparent frame passes pointer events to the map while no text field is being edited. Zoom/location controls stay above the sheet, and map clicks cannot create extra points until editing ends. Zoom level is preserved on selection. The ambiguous add-at-center button was removed. All icon-only buttons explicitly reset inherited padding and center their SVGs; card numbers align to the vertical center.

Reordering now previews positions using transforms, following the pointer while siblings move smoothly. The draft order commits on pointer release, with a settling animation; cancellation restores the order. Reduced-motion and keyboard reorder remain supported.

Addresses are optional across client, API contract and PostgreSQL (migration 0021 relaxes the length check without rewriting data). Missing-geocoder warnings no longer block confirmation. Placeholders are smaller, lighter and shorter. Removed the catalogue helper text. Drafts flush on page hide, except after successful submission.

Manual local browser check: three-point route including “Лесная поляна” with blank address, pan/zoom with sheet open, no accidental extra points, drag reorder, confirmation and reload. API tests cover empty/omitted address and coordinate validation; PostgreSQL test covers persistence and reload. Real touchscreen/pinch gestures require a phone; desktop pointer drag and zoom controls were exercised.

References: Google My Maps “Add places to your map” (direct placement and naming); Mapbox “Create a draggable Marker” (coordinate-based placement).

## Keyboard and address follow-up

The sheet uses VisualViewport height/offsetTop, freezes the page at its previous scroll position, and restores that position on close. Only the fields scroll; the header and confirmation actions stay in the sheet. Resize/scroll/focus listeners reveal the focused field inside that body and are removed on unmount. Inputs keep a neutral border without blue focus outlines.

Reverse geocoding now uses structured street and house-number fields. Missing streets yield an empty optional address. Existing editor drafts and legacy geocoder responses compact their address labels without districts, postcodes or country.

Validated keyboard geometry for overlay keyboards, iOS viewport panning, Android layout resizing, dismissal and pinch zoom. Browser checks at 390×420 and 390×300 showed the sheet bottom matching the visible height, focused fields above the fixed actions, document scroll unchanged, and no input outline/shadow. A physical phone's native keyboard was not available for testing.


## iOS scroll containment and sheet gestures

The previous overflow-only page lock was insufficient on a real iPhone, as reported by the user. The replacement handles cancelable touchmove/wheel events: only an overflowing form body or nested note may consume a vertical gesture, and gestures at either edge cannot pass to the document. The map remains pannable/zoomable before text entry. While entering text, the background intercepts gestures and a tap dismisses the sheet.

The layout viewport baseline survives keyboard resizing; a changed width resets it for rotation. The sheet tracks the visual viewport bottom, including offsets beyond the nominal layout edge. Focus is revealed by scrolling the form body only. On iOS, touch focus uses preventScroll and briefly hides the focused field until the next animation frame to avoid Safari's native focus pan; field arrows use the same focus handling. Window scroll is restored to the locked origin. Home-indicator padding is removed while the keyboard occupies the bottom edge. All listeners, temporary field styles, page styles and the previous page position are restored on close.

The close icon is removed. A deliberate upward drag of the handle expands the sheet; a downward drag dismisses it with a 160ms slide. Short taps outside also dismiss, while map pans, pinch and control clicks do not. Reduced motion removes the exit animation, and keyboard users have Escape and handle arrow controls.

Browser checks on the local synthetic fixture: 390×844 upward/downward drags; background dismissal restored the exact original page scroll (1136.5px) with the same three points. At 390×350 with a focused note, the sheet bottom equalled the visible 350px boundary, the comment remained above the actions, and wheel gestures on the action area left root scroll at zero. These are desktop pointer and viewport checks, not a physical iOS keyboard test. No iOS simulator is installed; native iPhone verification remains unavailable in this environment.

PWA typecheck and all 65 route feature tests passed. Regression tests exercise cancelable touch/wheel events, nested scrolling, both edges, non-overflowing forms, selection, map gestures before/during editing, cancellation, cleanup and viewport offset recovery.

Implementation references: [WebKit overflow/keyboard bug](https://bugs.webkit.org/show_bug.cgi?id=240860), [WebKit keyboard gap bug](https://bugs.webkit.org/show_bug.cgi?id=292603), [React Aria scroll prevention](https://github.com/adobe/react-spectrum/blob/main/packages/react-aria/src/overlays/usePreventScroll.ts).
