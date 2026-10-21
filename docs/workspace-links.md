# Workspace link navigation

The original HAPI preference `hapi-open-external-links-in-new-tab` is shared by
all workspace panes. `true` opens a new browser tab. A missing, invalid or false
value retains the original HAPI current-tab behavior. The additional explicit
`hapi-dsh-link-opening=dsh` option leaves navigation with the original DSH and
third-party plugin settings, including the official sidebar browser.

The workspace owns this navigation policy in its own `WorkspaceRoot` React
container. It does not modify a DSH component, substitute a Markdown renderer,
mutate slot registrations or copy another entry's child-slot declarations.
Only ordinary, explicit absolute HTTP(S) anchors in the workspace pane body
participate. The original anchor and its authored URL remain intact.

Ctrl/Cmd/Shift/Alt clicks, middle clicks, downloads, non-HTTP schemes, relative
paths, fragments and named-frame targets retain their browser or plugin owner.
Settings dialogs, portal dialogs and plugin pages outside the workspace panes
are outside this policy. A plugin can explicitly mark its own navigation region
`data-hapi-link-behavior="native"`; the workspace then leaves all contained
anchors with that owner. Choosing **Follow DSH and plugin settings** disables
workspace interception entirely.

## Save before leaving

Current-tab navigation first uses the existing shared workspace update
preparation contract. Participating editors prepare durable writes, then verify
their current binding, revision and attachments. A failure, timeout or changed
editor set keeps the current page and displays the actual persistence problem.
An active voice call, unfinished new-session form or incoming share insertion
must finish before leaving this way. The operator can cancel the pending
navigation while the save itself finishes.

Late completion of a cancelled, replaced or unmounted navigation intent cannot
leave the page. A new-tab open retains the current workspace and does not wait
for a save; it uses `noopener,noreferrer`. No source message is submitted by a
link click. These guarantees cover editors registered with the public update
preparation capability, not unknown private state in arbitrary plugins.

## Verification

`tests/client-link-opening.test.ts` verifies original-key/default migration,
official-policy opt-in, browser gesture exclusions, durable-write ordering,
failure retention and stale navigation cancellation. All four cases passed.

`e2e/workspace-links.spec.ts` loads original DSH Markdown links in two real
Conversation panes. It checks new-tab navigation and opener isolation, then
current-tab navigation followed by restoring both unsent input drafts. Its
destination page is an explicit browser route fixture; it does not contact an
external service. The single browser case passed against the shared production
build on 2026-10-21 (11.5 seconds of test execution). The same-page departure
included an edit immediately before the click, a real page navigation, and
restoration of both original official input drafts without sending a message.
See `validation.md` for the broader validation boundary.
