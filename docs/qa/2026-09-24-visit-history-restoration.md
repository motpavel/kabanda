# Raid point visit list restoration

The extra expandable “История посещений” wrapper introduced by release `91283db6941b7e0d317428fa860770652ae8fdb9` hid the participant counts that users need when opening a point. Remove that wrapper. `PointVisitHistory` again renders each visitor and count directly; tapping a visitor expands that person's raid list. Keep nearby history warming so repeated taps can use the cached summary immediately.

For a point whose current raid projection is known, show that status while the all-time summary has not arrived. Once the summary arrives, visitor rows replace the status when visits exist. When the summary has no visitors, keep the same current-raid empty sentence rather than replacing it with a second empty sentence. Suppress the “Уточняем историю” text during this known-state transition. Access-denied states still suppress projected private status and show retry/error feedback.

The compact materials composer and mobile keyboard handling remain as in the prior release. Unit and mobile browser validation are recorded with this release before publication.
