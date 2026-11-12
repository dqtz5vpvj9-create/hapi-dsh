# Avoid resolving document selection for outside text-area pointers

Each mounted Chat area installs a document capture pointer handler. A click on an unrelated navigation control currently reads `document.getSelection()` in every area before dismissing its action. A native browser trace attributes a synchronous style/layout flush to that read during return-to-latest navigation.

Snapshot the previous range only for pointer targets inside the owning text area. Outside pointers still dismiss the local action and reset the gesture without clearing selection; the last observed range prevents a dismissed action from reopening on an unchanged selection event. No public API or navigation timing changes.

The added regression first observes two selection reads for one outside click across two areas, then verifies zero outside reads and one read for the actual area receiving a selection gesture. All existing pointer, keyboard, context-menu, placement and dismissal cases pass. Browser frame acceptance remains a separate check; no performance improvement is claimed from the DOM tests.
