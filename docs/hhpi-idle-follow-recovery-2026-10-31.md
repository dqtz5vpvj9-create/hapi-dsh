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

## Executed validation and deployment

`npm run check` passes: 1,881 Node tests, 35 component tests, six fault
injections, type checks and the full build. Two existing Node cases are skipped
and are not counted as passed. The five history journeys, fifteen pinned
official-history contracts, four mounted DOM contracts and compiled module graph
contract pass separately. The Node and DOM evidence does not establish layout.

The two real Chromium component journeys pass with synthetic source data:

| Check | Desktop 1440×900 | Mobile viewport 390×844 |
| --- | --- | --- |
| Journey duration | 21.97 s | 50.76 s |
| Idle closures followed by successful reopening | 2 | 2 |
| Total subscriptions / extra history reads during reconnect | 3 / 0 | 3 / 0 |
| Reader position displacement during reconnect | 0 px | 0 px |
| Ready independent readers retained | 2 | 2 |
| Subsequent continuous earlier boundaries | 13 | 13 |

The component build took 583 ms; Chromium was `153.0.8010.12`. No scenario was
retried. These checks use real layout and official UI/stream code, with an
isolated loopback source and connection factory. Frame timing is observational,
as specified by the lab, and this result does not certify subjective smoothness.

Runtime commit `a93bd9a6fdab60c413591cb09896034cf0b49f0e` is pushed to `main`
and activated through formal release
`b4cdc1ea0c6dd5a87d46e3140b8efd069ab3504f59098046b653d2a81b3c184d`.
The extension package set is unchanged. Only the display Host was restarted,
after the authenticated ordinary running-session count was zero; original
Codex, native DSH and HAPI processes retained their PIDs/start times.

Authenticated HTTP, compressed WebSocket, three online HHPI sources and ten
served modules matching their installed release were verified, including the
official Gateway module used by the new helper. The Gateway module is external
in both application and source-provider bundles, with explicit graph metadata,
so its exported error class and `ctx.remote.$stream` share one module instance.

An unmodified authenticated production subscription stayed open for 45 seconds
after deployment, received its single zero-change opening confirmation and 22
heartbeat pings, and had no error/end/unexpected close. Production faults and
native writes were not injected. Desktop/mobile `webshot` captures were actually
viewed and show the target conversation body and editor. Captures establish
initial display, not a physical-device sleep/wake test.

Physical-phone sleep, OS background throttling and the exact triggering fault
on the reporting device remain unverified. The repaired failure/recovery path
has controlled and real-browser evidence; genuine source-domain failures still
use their terminal error path.
