# Original Runner capability compatibility

The workspace displays the original HAPI compatibility warning when an online
Runner lacks `agent-availability` or `cursor-chat-store-status`. A CLI version
label is shown for diagnosis; it is not used as a substitute for those declared
RPC capabilities. Offline Runners are excluded, and a disconnected Hub or an
unavailable current administration read cannot claim that a Runner is online.

The contract follows the pinned original HAPI revision
[`0f8ef6970884c92fb2ddca3070be2ec56cb50333`](https://github.com/dqtz5vpvj9-create/hapi/tree/0f8ef6970884c92fb2ddca3070be2ec56cb50333):
`shared/src/runnerCapabilities.ts`,
`web/src/components/RunnerVersionSkewBanner.tsx`, and
`web/src/lib/runnerSkewBannerState.ts`. The adapted implementation remains
AGPL-3.0-only. The DSH sources are unchanged.

## Workspace behavior

The warning occupies a bounded row in the workspace layout above its panes. It
does not float over the session sidebar, editor, terminal, or pane controls.
Minimize leaves a compact expandable summary. Temporarily dismiss hides it for
one hour. Both retain the original sessionStorage keys:

- `hapi.runnerSkew.minimized.v1`
- `hapi.runnerSkew.dismissUntil.v1`

The same browser session restores those preferences after a reload. Blocked or
full sessionStorage falls back to memory so the buttons still respond. No
dismissal preference is written to localStorage. A new browser session need not
inherit a previous session's dismissal.

The root workspace mounts one banner. Pane Client graphs do not create their
own banners. The banner and official Settings → HAPI Hub section share the same
administration read cache and `SourceAdminController`; repeated reads are
coalesced. While the root banner is mounted, a visible, online document refreshes
the read-only overview every 15 seconds and on focus, return to visibility, or
reconnection. A manual refresh is also available. Hidden documents do not poll.

## Restart semantics

The compatibility warning offers a restart only when the Runner is online,
declares supervised restart, and its running binary's modification time differs
from the installed binary's modification time. Both values must be finite
numbers. A rollback therefore qualifies just as an upgrade does; the UI says
the installed binary **differs**, rather than claiming it is newer. A missing
capability without a changed binary requires installing a compatible CLI.

An explicit restart uses the existing original Hub route and the same durable
administration operation journal as Settings. Its exact operation ID is saved
before dispatch. Closing Settings or reloading the page does not create another
restart. If the original reply is lost, the button is blocked for that unresolved
operation, and “Read original restart” only checks the existing receipt. A later
source process observation can resolve the journal to `observed`; it does not
invent the lost original acknowledgement.

The general supervised restart control remains available in Settings for other
administration needs. The compatibility banner is a narrower update-recovery
entry point, not a replacement for that existing control.

## Verification boundary

Focused tests cover exact required capabilities, online filtering, finite
modification times and rollback, original preference keys, one-hour expiry,
blocked-storage fallback, shared mutation ownership, unknown receipt recovery,
read coalescing, and disposal of an in-flight read. The browser scenarios exercise
the pinned, unmodified official DSH workspace and Settings with an explicit HAPI
wire fixture. They do not restart a real user's Runner or validate a particular
supervisor installation.

On 2026-10-21, an isolated build of the Phase 3 UI checkpoint passed both
`e2e/runner-skew.spec.ts` scenarios and the existing `e2e/admin.spec.ts` scenario:
**3 passed (35.9s)**. The run used the pinned, unmodified official DSH UI with
Chromium and one Playwright worker. Both compatibility scenarios assert zero
page errors; the administration scenario also retains its console-error check.
The exercised paths include desktop and mobile layout, original preference-key
restoration, capability and restart eligibility, rollback, shared banner/Settings
ownership, an unknown restart across reload, and read-only receipt reconciliation.
The administration regression also completed settings, machine profile, usage,
and database-backup download. These results apply to that UI checkpoint; the
repository-wide integration record remains in `validation.md`.

The original banner also invokes HAPI's platform haptic bridge. This DSH web
composition does not currently expose that bridge, so Telegram or device-specific
tactile feedback is not claimed as equivalent here.
