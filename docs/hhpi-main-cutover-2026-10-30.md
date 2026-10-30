# HHPI main cutover: 2026-10-30

The production display Host now uses HHPI-only configuration with two direct native Codex sources. At application revision `ca045213a8dfb846e8d61728799928566df220cd`, the target Pane displays both official Chat content and an editable composer. **Continuous-reading production acceptance has not passed.**

The architecture comparison is available as [interactive HTML](../.lavish/hapi-hhpi-correspondence.html) and [standalone SVG](../.lavish/hapi-hhpi-correspondence.svg). It compares responsibilities with the local HAPI Native Codex path, not complete call order or measured performance.

## Installed release

- Release ID: `6df2d74dda54feb814fed51fb809fefc7abea567ec67a1517d6f7e57edbe830f`.
- Extension label: `hhpi-input-occurrences-20261030`.
- Source patch fingerprint: `c49b1d1043711139fd10a7271cf6f7fcad5a3a7b2ba214a399febbe02a7eb7ac`.
- The complete eleven-package source extension includes the official Input Trigger and Commands services. Both resolve retained Pane bindings through the scoped binding API; canonical native paths retain their existing behavior.
- The formal bundle installer activated the release. Before restarting the display Host, the authenticated official running-session query reported zero ordinary DSH executions. Original native engines were not restarted.
- Authenticated HTTP, compressed WebSocket and all nine checked served client modules matched the installed release. Both configured Codex sources were online.

Two old DSH Panes retain their original references and are not accepted as migrated observation paths. The managed Runner remains offline. This cutover does not establish complete native DSH federation acceptance.

## Verification and limits

`npm run check` passed at the application revision above: 1,859 Node tests, 35 component tests, type checks, the build and six specified fault-detection checks. Two optional tests were explicitly skipped. The complete installed extension also passed five official reading/input/mounted-component contracts with no skips. These are development and integration results, not production scroll acceptance.

The previous production probe compared a row captured at the beginning of a paging loop with mounted rows after potentially many user gestures. Its comparison included row controls. That condition can confuse legitimate virtual-list unloading or changing controls with a prepend regression.

The updated probe obtains each real `hhpi/read` response through `route.fetch()`, samples the currently visible source-correlated body immediately before delivering that response unchanged, and reports separate identity, body and virtual-range verdicts. Its eight behavior tests, syntax check and diff check passed. It does not automatically pass an absent or invisible anchor.

One serial read-only production run with this probe produced:

| Scenario | Duration | Earlier segments visibly accepted | Failure |
| --- | --- | --- | --- |
| Desktop | 5.424 s | 1 | Second segment: sampled row outside the mounted virtual range |
| Mobile viewport | 7.609 s | 1 | Second segment: sampled row outside the mounted virtual range |

Both contexts had one target Pane, one scrollport, one editable composer and one changes stream. Neither attempted a production write or disallowed stream. Neither reached the cached-tail or final frame-gap verdict. No repeated run was used to obtain a passing result.

The result still fails acceptance. It does not alone establish whether the row left the mounted range through normal continued gestures or an actual commit-position error: the comparison is made when new earlier content becomes visible, which can be later than the commit itself. The next diagnostic must observe the official publication/layout boundary and correlate immutable source identity with position before attributing this to product code. It must preserve real source data, user scrolling, the existing displacement threshold and the scenario budget.

Physical-phone touch feel, soft-keyboard viewport changes and hardware input methods remain unverified. The synthetic browser report in [the earlier browser verification record](hhpi-browser-verification-2026-10-30.md) describes a separate isolated source and does not supersede these production failures.
