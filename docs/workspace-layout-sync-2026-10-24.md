# Workspace layout synchronization

The repeated choose-layout banner came from two separate errors. Any saved browser layout different from the server was treated as a conflict, including an unchanged but older cache. Applying a server layout also triggered the local store listener and saved the same document back to the server. Independent browsers therefore advanced the server revision just by opening the workspace.

The browser now stores the last confirmed shared layout alongside its current layout. Receiving a snapshot suppresses the write-back path. Shared geometry changes since that baseline are rebased onto the latest server snapshot; focus, the active window and zoom remain local. CAS and the transport's existing operation identities remain in place. Acknowledging an earlier save does not erase newer local edits.

Old browser caches have no reliable baseline. On the first upgrade, a different cached layout is saved as a browser-local recovery copy, the server layout is accepted, and any changes made while that read was pending are replayed. The pane menu can restore the previous browser layout. Explicitly accepting the server after a genuine conflict updates this recovery copy to the layout being replaced.

Independent window and pane edits merge automatically. Conflicting closes, changed resource bindings and incompatible tree reorganizations preserve the current local view and expose the layout choices in the pane menu. Dirty editor guards can veto a remote replacement. Routine cache divergence no longer produces a banner across the reading area. This does not add live push delivery for remote geometry; changes are reconciled on opening, reloading and CAS conflicts.

## Regression evidence

The old `5b6ff47` build failed the real-Host negative control: the server revision advanced **4 → 5 → 6** on desktop and mobile restore, although all three window documents were identical. The evidence is in `/mnt/cache/data-cache/hapi-workspace-sync-old-red-revisions.json` and `hapi-workspace-sync-old-red.log`.

The first candidate confirmed the no-echo fix (**5 → 5 → 5**) but exposed a separate existing window-menu bug. `ResizeObserver` set the menu's inline `visibility` to `hidden` imperatively; subsequent React positioning updates did not remove that property. The fix leaves visibility under React's initial layout effect and only updates coordinates on later measurements. The failing keyboard and context-menu runs remain preserved; they do not count as successful synchronization acceptance.

`tests/workspace-rebase.test.ts` exercises stable IDs, independent edits, local focus/zoom, splits, moves, closures, source display generations and resource uniqueness. `tests/workspace-controller.test.ts` additionally covers startup selection, clean restore, old-cache recovery, failed initial reads, offline edits across reload, save acknowledgement races and dirty-editor vetoes. Transport tests retain the existing CAS and uncertain-operation retry checks.

`e2e/workspace-sync.spec.ts` uses independent desktop and mobile browser storage against a real official DSH Host with synthetic source conversations. It checks server revisions, actual window-menu interactions, two-device renames, local drafts and selected windows, repeated reloads and a new browser context. The failure scenario rejects one browser's real layout-save request before it reaches the Host; it is not a claim of a physical-device network outage. No messages are sent. Screenshots use the fixed webshot path and must be visually inspected.

## Final candidate results

- 72 targeted controller, transport and rebase tests passed.
- Both official-Host browser scenarios passed in 39.8 seconds. A used the keyboard window menu; B used a real CDP touch long-press on mobile and the desktop context menu. All required menus became visible and accepted the rename action.
- A: seeded server revision 5 stayed at 5 after both browsers opened. The deliberate desktop rename advanced it to 6; two mobile reloads and a fresh context stayed at 6.
- B: one mobile save request was deliberately blocked. The desktop rename advanced 5 to 6; the resumed mobile browser merged both names and advanced once to 7. Three alternating reloads and a fresh context stayed at 7.
- Draft text, the mobile selected window, both window names, and absence of both the old banner and unresolved menu conflicts were asserted through the real UI. No source messages were sent.
- The first post-menu-fix browser runs stopped on an unrelated full optional-plugin activation mark after reload. The final readiness condition uses the visible active conversation body and composer, with the target browser brought to the foreground. Revision, draft, selection and conflict assertions were retained; timeouts were not increased.
- All four final webshot images were actually inspected at 1440×900 and 390×844. The mobile reading area has one title row, a compact composer and one bottom navigation row, with no choose-layout banner or page overflow. These are synthetic Chromium mobile-viewport results, not a physical-phone claim. Visual replay is separate from the revision measurements.

Final browser evidence: `/mnt/cache/data-cache/hapi-workspace-sync-visible-ready.log` and `/mnt/cache/data-cache/hapi-workspace-sync-visible-ready-results/`. The preceding menu visibility failure is preserved in `/mnt/cache/data-cache/hapi-workspace-sync-menu-diagnostic-results/`.


## Release verification

`npm run deploy` completed the final typecheck, 1,159 logical tests (1,158 passed, one skipped, zero failed), and client-only build. Authenticated HTTP and compressed WebSocket checks passed. The live asset contains the exact local client bundle (1,300,814 bytes); its build timestamp is `2026-10-24T03:00:29.479Z`.

The display Host remained active with its existing start time, `Fri 2026-10-23 09:33:14 PDT`, and `NRestarts=0` before and after publication. No Hub, Runner, native execution or upstream DSH source was restarted or modified.
