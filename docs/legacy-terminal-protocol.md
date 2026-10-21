# Original SessionTerminal Host adapter

The legacy terminal adapter lets the unchanged DSH terminal model and terminal
view display an existing HAPI `schemaVersion: 2` SessionTerminal resource. Its
execution connection still uses the original HAPI `/terminal` protocol and the
saved source session and terminal ID. It does not route this resource to HAPI's
separate machine TerminalHost protocol.

The companion [view integration document](legacy-session-terminal.md) describes
the client kind, official view composition, controls and browser verification.
This document describes the Host protocol and the limits imposed by the source.

## Identity, authorization and public interfaces

[`LegacySessionTerminals`](../src/hapi/legacy-terminals.ts) keeps one connection
for each exact `(sourceHubId, sourceSessionId, machineId, terminalId)` tuple.
Its `hapi-legacy-…` display ID is derived from that tuple. The original terminal
ID is sent to HAPI unchanged. Every public operation requires the current DSH
display Session's authoritative source mapping; caller-supplied hints cannot
choose a different source machine or Hub. Source authentication stays on the
Host.

The public source APIs are deliberately small:

| Operation | Effect |
| --- | --- |
| `sourceLegacyTerminalOpen` | Explicitly prepares or reconnects the exact saved original resource. |
| `sourceLegacyTerminalRead` | Reads an existing adapter record; does not connect. |
| `sourceLegacyTerminals` | Lists only this source Session's legacy adapter records; does not connect. |
| `sourceLegacyTerminalText` | Reads decoded text from the existing adapter screen at one output boundary; does not connect or claim input. |

After Open, the official `terminal.retain`, `terminal.attach` and
`terminal.rename` methods dispatch these reserved IDs to the adapter. Their
ordinary DSH and machine-terminal branches retain their existing delegation.
The official Remote Gateway still provides its original authorization and
invocation/uplink handling. An unknown legacy ID fails closed; it is never
passed to local process creation or machine TerminalHost.

Ordinary `terminal.list` does not include legacy IDs. The separate legacy client
kind uses the legacy-only inventory and the real official `ClientTerminals`
service. This matters because the default terminal kind treats an explicit tab
close as process cleanup. Legacy `terminal.create` and `terminal.close` are
rejected: this kind opens its saved source resource and closes by detaching its
view. Rename changes an adapter display alias; the original protocol has no
terminal-name update operation.

## Preserved source semantics

The source `terminal:create` operation is **attach-or-create**. The pinned HAPI
CLI reuses a live terminal with the same ID; if that terminal no longer exists,
the source may start a shell under that same original ID. The protocol has no
`existingOnly` flag or separate existence query. This adapter does not claim
that reopening a resource can prove the previous process survived.

HAPI's Hub permits a new viewer to bind a detached terminal. It rejects another
viewer while the original terminal is attached to a different active socket.
The adapter therefore multiplexes its DSH views over one authenticated source
connection. It does not seize an independently attached HAPI browser's terminal.

Closing a DSH pane, ending a retention stream or stopping this adapter only
disconnects the source viewer. None of these paths emits `terminal:close`, agent
abort, or another process-termination operation. The source owns its PTY and its
existing idle cleanup policy. A local DSH retention hold is not a promise that
the source's idle timer or Runner lifetime has changed.

An Open request's cancellation signal controls that caller's wait. It does not
own the prepared source connection after the response returns. The Host grants
a bounded ten-second handoff for official view retention/attachment. When the
last preparation, retention hold and physical view are gone, the Host detaches;
an unclaimed Open cannot leave an indefinitely retained socket.

An observed `terminal:exit` preserves the source's real exit code/signal. An
ordinary attach then shows the retained exited screen and does not reconnect.
Only an explicit Open/Reload may invoke the original attach-or-create operation
again. Transport failure is reported as disconnected or failed, never as proof
that the process exited.

## Output, replay and actual screen state

The original version 1 output protocol identifies each source stream by an epoch
and UTF-16 offsets. Offsets are JavaScript string code units, not UTF-8 byte
counts, Unicode character counts or DSH output-frame sequence numbers.

The adapter processes source output through a FIFO and a real `@xterm/headless`
terminal. It advances the accepted source cursor only after xterm completes that
write. Source overlap is trimmed at the accepted cursor, and duplicate output
does not create a second DSH output event. Reconnection drains previously
admitted writes before choosing the next source cursor.

Each official attachment begins with a real SerializeAddon snapshot of that
decoder. Joining the follower, capturing the snapshot, choosing the DSH output
sequence and assigning input control occur in the same FIFO operation. An
output chunk already included in the snapshot cannot also arrive later as an
older incremental frame.

The source retains a bounded raw output tail of 256 × 1024 UTF-16 code units.
That tail is not an authoritative complete VT screen: an earlier escape
sequence or scrollback line may already be gone. An initial source `truncated`
flag remains visible in adapter facts. `history-truncated`, `epoch-changed` or
`cursor-ahead` gaps disable input and require an explicit bounded replay reload.
The adapter does not silently reset the decoder and present the result as
continuous history. Owned malformed output, an unknown output owner, unsupported
replay or inconsistent offsets also fail closed. Clearly identified events for
another source terminal are ignored.

The legacy decoder and official legacy view retain the original 10,000-row
scrollback policy by default. This is independent of the ordinary official
terminal's default scrollback. The exposed `TerminalEnvironment` reports the
actual legacy limits. Per-receiver and pending-output queues are bounded; a slow
receiver loses its input control immediately, and failed queues discard old
ACK/state frames before reporting failure.

Inactive decoder caches are bounded by the per-source terminal limit and a
global limit of 512 records. Opening a new resource can evict least-recently-used
records only when they have no preparer, retention hold, follower, handoff,
pending output, opening attempt or source socket. Active views are never evicted.
Opening an evicted resource again uses the source's bounded replay and retains
that limitation; an old detached cache cannot permanently consume the quota.

## Input admission and control

The newest physical official attachment owns adapter input control. Other
attachments continue observing output and receive explicit read-only refusals.
When the writer closes, an older view is not silently promoted to writer. A new
attachment is needed to obtain control.

The original `terminal:write` and `terminal:resize` protocol has no Runner
acknowledgement. The official wire's ACK therefore means only that this adapter
accepted the command into the presently writable volatile transport. It does
not prove Runner receipt, shell execution, or successful command completion.
The compatibility state exposes `inputAcknowledgement: 'adapter-transport'` so
the view can explain this once without interrupting every keystroke.

Writes require a source-ready connection, an accepted replay cursor and current
view control. A blocked transport rejects input. A dispatch exception records an
uncertain outcome and ends that input attachment. Socket.IO's send buffer is
not used for input: writes and resizes use volatile sends. The adapter never
persists or replays input across transport loss, view remount, source replay
reload or Host restart. The screen decoder has no source `onData` callback, so
parsing replay does not itself send terminal-response bytes to the process.

## Facts the original protocol does not report

The source-ready event reports identity and replay support. It does not report a
PID, shell executable, shell arguments, initial process directory or terminal
title. The adapter does not invent these values.

| Public field | Meaning for this adapter |
| --- | --- |
| `WebTerminalInfo.title` | Adapter display alias, initially `HAPI SessionTerminal`. |
| `WebTerminalInfo.shell` | Empty path/argv with the explicit name `Shell not reported by legacy source`. These are unreported sentinels and never shell-launch candidates. |
| `WebTerminalInfo.cwd` | Empty unreported sentinel for the existing PTY's initial cwd. |
| `TerminalEnvironment.cwd` | Current logged source Session directory, matching the official environment contract; it does not establish the existing PTY's initial or current shell cwd. |
| `facts.dimensions` | Dimensions submitted with a source-confirmed Open, or subsequently accepted by this adapter for resize. The basis records which of those occurred; resize has no Runner ACK. |
| `facts.lastSourceReadyAt` | Host observation time of an actual source-ready event. |

## Read-only scrollback copying

`sourceLegacyTerminalText` reads the same headless decoder through the output
FIFO. Its `sequence`, timestamp and text therefore describe one parsed output
boundary. It uses public xterm buffer cells and joins wrapped rows using the
original HAPI SelectOverlay rule. It does not use the machine TerminalHost text
API, attach another source viewer, claim input, resize the PTY, or infer a cwd.

The result identifies its provenance as `adapter-observed` and its source history
as `bounded-source-tail`. `replayIssue` preserves the source truncation/gap fact.
The separate `localLimitReached` flag reports the local decoder/text capacity;
it does not claim the source supplied complete history. Text is limited to
11,000 rows and 8 MiB, keeping a Unicode-safe tail when necessary. Plain xterm
selection copy remains the direct choice when a selection exists.

## Verification and provenance

The 13 cases in
[`hapi-legacy-terminals.test.ts`](../tests/hapi-legacy-terminals.test.ts) exercise
the protocol fixture with real headless xterm, SerializeAddon, Cordis isolation,
and the unchanged official Remote Gateway. They cover source ownership,
baseline/output ordering, UTF-16 replay and deduplication, multi-view control,
cancellation/handoff, source-ready without replay, gaps, malformed frames,
receiver overflow, detached-cache eviction, retained text, observed exit, and
the absence of a create/kill fallback.

The existing nine
[`hapi-machine-terminals.test.ts`](../tests/hapi-machine-terminals.test.ts) cases
also run against the shared provider to verify that its machine-terminal and
ordinary DSH delegation still preserve their original behavior and Gateway
authorization. These are protocol/adapter tests; no fixture is represented as a
live shell, actual Runner acknowledgement or user's existing PTY.

The pinned upstream implementations are recorded in [UPSTREAMS.json](../UPSTREAMS.json):

- HAPI [`terminal.ts`](https://github.com/dqtz5vpvj9-create/hapi/blob/0f8ef6970884c92fb2ddca3070be2ec56cb50333/hub/src/socket/handlers/terminal.ts),
  [`terminalRegistry.ts`](https://github.com/dqtz5vpvj9-create/hapi/blob/0f8ef6970884c92fb2ddca3070be2ec56cb50333/hub/src/socket/terminalRegistry.ts),
  [`userTerminalBuffer.ts`](https://github.com/dqtz5vpvj9-create/hapi/blob/0f8ef6970884c92fb2ddca3070be2ec56cb50333/hub/src/socket/userTerminalBuffer.ts),
  and [`TerminalManager.ts`](https://github.com/dqtz5vpvj9-create/hapi/blob/0f8ef6970884c92fb2ddca3070be2ec56cb50333/cli/src/terminal/TerminalManager.ts).
- DSH `@deepseek-ai/dsh-api-terminal-controller` version `0.2.1-rc.2`,
  unmodified. The adapter uses its public frame/environment contracts and
  provider composition; the client uses its real public service and view model.
