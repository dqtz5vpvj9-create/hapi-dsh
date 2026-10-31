# Restore idle HHPI subscriptions with the official RemoteStream

An HHPI source subscription ending or losing its carrier could mark every open
reading occurrence as failed, even while all accepted transcript data remained
resident. `RemoteSourceHistory.startFollow()` passed the raw stream's failure to
its windows. Official `BoundHistoryView.consume()` then entered `phase=error`,
and the input dock rendered its generic “load earlier” error. No older-page
request was necessary to trigger that display.

This path is reproduced with controlled stream closure and the real pinned
`RemoteSourceHistory`, `BoundHistoryView`, Chat assembler and commit coordinator.
It does not prove the exact network or source fault on the reporting phone.
A separate authenticated, read-only production subscription remained open for
45 seconds, received 23 physical heartbeat pings, and had no error or terminal
frame. That observation rules out claiming an unconditional 45-second idle
expiry; it does not rule out a later disconnection or device/background loss.

## Change

`RemoteSessions` now runs source updates through the existing official
`ctx.remote.$stream` lifecycle via `src/client/remote-follow.ts`. Official
Connection retains physical retry timing and generation changes. HHPI supplies
its last consumed source epoch/version when reopening the logical subscription.
An unexpected normal end has no successful terminal meaning for an ongoing
subscription and is classified as a carrier interruption.

Both native adapters confirm a successfully opened, already-current cursor with
one zero-change frame (`base=version`, unchanged epoch/version, empty upserts and
removals). It changes no source revision and publishes no Chat update. This
acknowledges quiet streams even before the next real message; repeated idle
reconnections therefore reset the official stream's successful-generation
state rather than exhausting its unopened-stream retry allowance.

The helper advances its cursor only after the window consumer has processed a
frame. Replayed older versions cannot move that cursor backward. Source revision
changes still follow the existing reset path. Closing the last reader cancels
both the active iterator and its reconnect wait.

Carrier recovery does not fail the accepted history feed, replace its body,
read a new baseline or move the official reading position. There are no new
retry intervals, heartbeat constants, native sessions or write retries.
Authorization, protocol and source-domain errors remain terminal. In particular,
a genuine missing source or owner/catalog error is not reclassified as a
successful read; those errors remain independently actionable.

## Regression coverage

The pinned official-history contract now covers normal idle end, a physical
`RemoteStreamCarrierError`, resuming after an already accepted live revision,
unchanged body/node identities in two independent panes, later live delivery,
terminal ordinary/source errors, and releasing the final reader during recovery.
Host generation is controlled through the official observable store; no sleep
or made-up reconnect timer determines success.

The mounted DOM fixture and Chromium component lab supply the real official
`RemoteStream` factory at their declared connection boundary. The browser source
can close only its isolated synthetic update subscription. Both desktop and
mobile journeys check that the subscription reopens with the same cursor,
both official readers remain ready across two successive idle closures, accepted body and visible keys stay in
place, and no extra history read occurs. The existing thirteen continuous
older-boundary, cache, independent draft and input checks remain in those same
two bounded scenarios. No production connection or native operation is faulted.

Live production acceptance and actual browser results are recorded below when
executed. Controlled DOM and source tests do not certify physical-phone sleep,
OS background throttling or subjective scrolling smoothness.
