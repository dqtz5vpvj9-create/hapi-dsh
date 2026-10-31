# Native DSH compaction citations must not expand a transcript page

A native DSH long conversation could open and page normally, then fail with
`CAPACITY_EXCEEDED` when an older page crossed a compaction checkpoint. The
checkpoint's `sourceEventSeqs` cites the model surface that it replaced. HHPI
incorrectly treated every citation as a required Chat dependency and recursively
loaded the cited turns, steps, assistant messages, calls and results into one page.

The reported source contains 8,990 native events. Its failing page has 160 body
events but expanded to 3,252 entries, including 3,092 context events, occupying
17,494,854 serialized entry bytes. This exceeds the unchanged 12 MiB single-page
admission budget. The failure occurs in `RemoteHistoryWindow.performRead`, before
the official reader's candidate publication or anchor restoration. Private source
identities and message contents are excluded from this report and the tests.

## Change

`src/remote/dsh-history.ts` collects only rendering dependencies: turn and step
starts, the assistant/call records needed by tool results, and request headers.
It forwards original event objects, sequence numbers, `surfaceOp` and
`sourceEventSeqs` unchanged, but no longer fetches cited provenance as page
context. Earlier transcript material remains available through ordinary,
contiguous native pages.

This follows the pinned DSH `0.2.1-rc.3` contract: `sourceEventSeqs` records cited
surface sources, including a replacement's shadowed range. Official Chat renders
append-origin transcript messages; replacement copies are model-only material.
It does not require eagerly loading the whole shadowed range for a human reader.
No reader budget, cache limit, native log or execution owner changes.

## Regression evidence

`tests/hhpi-dsh-native-history.test.ts` now writes a valid native v4 compressed
log through official persistence. The fixture contains a complete compaction
lifecycle, 768 cited messages of 20 KiB each and 960 later messages. Individual
pages fit the existing admission budget; the entire cited range does not.

The regression executes `DirectDshHistory` and the production
`RemoteSourceHistory` reading window. With the original pager it fails at the
real admission check with `CAPACITY_EXCEEDED`. With the fix it reads all 11 pages
continuously, retains the accepted tail, preserves checkpoint metadata and reuses
all visited intervals after returning to latest. The existing cross-page tool
result test still requires its original assistant, call, turn and step context.

The earlier six-page fixture contained no compaction checkpoint. It exercised
ordinary paging and could not expose this dependency expansion. The new case
specifically crosses that boundary after the initially successful pages.

## Validation boundary

The source-specific in-process probe executes the pinned official
`BoundHistoryView`, Chat definitions, assembler and window commit coordinator,
with the production native pager and reading window. All 57 source pages pass in
three complete-window growth modes: without a mounted reader, anchored to the
earliest displayed node, and anchored to the latest displayed node. Each reaches all 8,990 original
events and 2,787 derived nodes. The formerly failing page now contains 162
entries (two context records), occupying 513,626 entry bytes. No individual page
exceeds 1,165,843 entry bytes. Reader geometry is controlled in this probe; these
are publication/semantic-anchor results, not pixel measurements.

Each prepend retains every prior official snapshot node key, the exact text
block sequence for every existing body owner and the relative order of old body
owners in the official grouped reading order. Tool-call owners remain resolvable
through `containsReadingKey`. Both reader modes perform 56 corrections against
the actual `view.reads` owner. The probe supplies official Chat's real
`UiConversation.prototype.inspectSystemPrompt` service; it does not replace that
interpretation with a fixture. An initial flat-text-suffix assertion was discarded
because context inserted into existing groups can interleave old and newly
loaded owners without changing any old body or its relative reading order.

Full `npm run check` passes, including 1,881 Node tests, 35 component tests,
the six fault injections, type checks and build. `npm run test:history` passes
its five journey tests; the eight pinned official-history contracts also pass.
The full Node run records two skipped cases, which are not passed checks.

A source page fitting its admission budget does not by itself prove smooth touch
scrolling, stable pixels or physical-phone behavior. Those results must be
reported separately from source traversal and official in-process publication.

## Production release

Runtime commit `cdbc113b26a4e1a41ac446e07812797b320976f3` is installed through
formal release `c99cc029dddeac704194303c1f0b5ec31fbf3774fa8d173b486e4bd426c23db3`.
The existing 11-package `hhpi-continuous-admission-20261030` extension set is
unchanged. The display Host was restarted after the authenticated ordinary DSH
running-session check returned zero; original native DSH, Codex and HAPI
processes retained their PIDs and start times. The prior release is retained.

After activation, the authenticated production `hhpi/read` endpoint traversed
all 57 pages in 5.37 seconds, with 8,990 original body events, no gaps or
duplicates, at most 243 entries per page and at most 1,165,843 entry bytes.
This is API traversal time, not browser scroll time. The former failing page
has 160 body and two context records, totaling 513,626 entry bytes. No native
writes were performed. Authenticated HTTP, compressed WebSocket, all three
online HHPI sources, the disabled legacy body path and nine served browser
modules matching the active installed release were verified separately.

The bounded production browser check remains **failed**:

- Desktop: six earlier source-content segments became visible; nine measured
  publications retained their anchors at zero pixel displacement, and returning
  through cached tail content made zero extra history reads. The maximum frame
  gap was 350 ms, exceeding the existing 80 ms gate. The measurement includes the
  probe's own DOM/source correlation and has not isolated product frame cost.
- Mobile viewport: two earlier source-content segments became visible and both
  measured publications retained anchors at zero pixel displacement. The third
  segment was not reached within the bounded journey. At exit the scrollport was
  still 3,407 pixels below its current top, with a 14,906-pixel scroll range.
  This run did not reach the next paging boundary and cannot establish a stuck
  read there. It also does not satisfy the required six-segment mobile check.
- Neither scene recorded a browser page error, blocked native write or source
  stream error. No capacity error was observed. Neither scene was retried.

Separate `webshot` captures of the same native conversation in desktop and
390×844 viewport both waited for its body and editor. Both images were actually
reviewed: the restored body and composer are visible. These screenshots do not
replace the failed interaction/performance verdict above. Physical-phone touch,
soft keyboard and subjective scrolling remain unverified.
