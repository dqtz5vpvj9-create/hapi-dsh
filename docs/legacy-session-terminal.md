# Existing HAPI SessionTerminal panes

Imported HAPI `schemaVersion: 2` terminal panes now use the unchanged official DSH terminal body and title inside the same per-pane plugin graph as other workspace views. They retain their original source Hub, source session, `terminalId`, window, pane identity and split geometry. They are not adopted as new machine TerminalHost terminals.

The original HAPI protocol is **attach-or-create** for the supplied terminal ID. If that source no longer retains the old PTY, the protocol may create a terminal under that same source identity. It does not report enough process metadata to claim that an old operating-system process survived. The visible compatibility summary and its expanded explanation make this distinction explicit.

## Official view and plugin ownership

The workspace no longer mounts a separate xterm renderer. The thin [legacy resource route](../src/client/legacy-session-terminal.tsx) derives a normal sidebar tab destination. The [legacy view installer](../src/client/legacy-terminal-view.tsx) registers that kind with the official `sidebarRightTabs` registry and borrows the existing public leaf body/title contributions. It preserves their injected theme, locale and view interfaces. It does not copy an entry that owns a private store or child-slot subtree.

The [client binding adapter](../src/client/legacy-terminal-client.ts) constructs a real public `ClientTerminals` service in a Cordis `webTerminals` isolation scope. It uses `ClientTerminals.view()` with an explicit saved identity. The official model owns screen delivery, parse acknowledgements, ordered input, window holds, view mounting and detachment. Its separate inventory reads only the legacy source API; it never calls machine-terminal `environment`, `list`, `create` or shell discovery to invent facts about the old PTY.

Every pane uses its own actual `SessionReference` and `SessionProvider`. The source projection must match the saved original source IDs. Missing or mismatched identity remains an explicit unavailable view; the root shell’s current session is not a fallback.

### Extension surface

These names and types are exported from `hapi-dsh/client`:

| Public contract | Value or purpose |
| --- | --- |
| `LEGACY_TERMINAL_TAB_KIND` | `hapi-legacy-terminal` |
| `LEGACY_TERMINAL_SEAT_ID` | `hapi-dsh/legacy-session-terminal` |
| `legacyTerminalPaneTarget(resource)` | Builds the normal tab destination and a stable, versioned address from the original terminal resource |
| `legacyTerminalNavigationParams(navigation, displaySessionId)` | Validates explicit parameters or restores missing parameters from a supported address, with the actual graph Session as the display-only boundary |
| `canOpenLegacyTerminalAddress(address)` | Checks the public address syntax; the body still validates its source projection before admission |
| `LegacyTerminalInjected` | Real official `view()`, source occurrence, public terminal/source observables and theme |
| `LegacyTerminalBodyProps` / `LegacyTerminalTitleProps` | Standard slot props plus those injected capabilities |
| `LegacyTerminalOccurrence` | Exact source admission, explicit reload and read-only adapter facts |

A plugin can deliberately support this kind through the normal DSH tab and slot registries. The compatibility view does not introduce another plugin registry. A plugin that contributes only to ordinary `terminal` tabs does not automatically replace the legacy kind: the independent kind prevents the ordinary terminal close handler from terminating an original source terminal.

Plugins should use `legacyTerminalPaneTarget` to produce the address and parameters together. A source-bound address identifies the original Hub, source session and terminal, so its identity remains stable when the displayed Session generation changes. An address without an original source session is explicitly display-bound and is accepted only in the matching graph Session. The decoder distinguishes these two cases; it does not infer a source identity from an ambiguous session ID.

The official title’s double-click rename changes an adapter display alias. The UI labels this accurately. The original shell executable and initial PTY directory are unreported. Empty sentinels in the official terminal metadata are not launch paths. The environment’s directory is the source session’s current logged directory, and its limits are the actual limits enforced by the adapter, including the original 10,000-line scrollback default.

## Navigation, lifetime and recovery

A terminal resource may save an optional official `target` and title while retaining its original terminal and source identity. Switching to Files, another supported plugin view, or Conversation is therefore restorable without rewriting the legacy resource. Split geometry and per-window focus remain workspace data; provider-specific view state remains with the official plugin.

The official tab store can restore a retained, inactive tab with its address but without transient navigation parameters. Only when `params` is absent does the compatibility tab recover its original binding from the versioned address. Present but invalid or mismatched parameters remain an error. The restored binding must still match the actual pane Session projection. An earlier ambiguous address format requires its original explicit parameters and is never guessed.

Session catalog hydration is separate from user navigation. A delayed main-view reference does not replace a restored terminal, document or plugin resource with a chat resource, and a temporary gap between released and retained references is not treated as a request to clear the pane. Later explicit navigation to another Session still changes the pane normally.

Closing a pane or its legacy tab releases the occurrence and window hold. It does not call `ClientTerminals.close()` or emit `terminal:close`. The original source retains its own idle policy. A pending environment response that arrives after a tab closes is reconciled against the latest open-tab inventory, so it cannot leave a late window hold behind. A cancelled initial admission can be retried by a subsequent real mount of the same occurrence.

The legacy adapter refuses a legacy process-close request. If the official client already holds a nonlegacy durable close intent, it delegates that request to its original terminal remote instead of falsely acknowledging it or filtering private persistence keys.

Reload is an explicit operation. It refreshes the existing official view and allows a failed source replay to be reopened through the original protocol. It never resends past input. Ordinary read/list/copy operations do not create a source connection. An observed exit is not silently revived by reconnecting a view. The exact protocol and source limits are documented in [Legacy terminal protocol](legacy-terminal-protocol.md).

## Controls and copy

The official body retains the existing public terminal-control composition: the saved two-row touchbar, custom keys and escape-sequence macros, snippets, sticky and one-shot modifiers, hold-repeat, command input, clipboard paste and paste fallback. Legacy A−/A+ buttons change only the current view’s font. Shared `hapi-terminal-font-size`, `hapi-terminal-touchbar-keys` and `hapi-terminal-toolbar-settings` remain the same preferences used by the other terminal panes. Theme changes update the existing official xterm instance.

All physical, toolbar, macro, paste and command input reaches the same official `TerminalView.write` owner. A synchronous public-model refusal preserves the command or paste draft and its modifiers. Accepted local admission is not described as proof of Runner execution: the old source protocol does not acknowledge individual input. Disconnected or uncertain input is never replayed.

Touch scrolling and pinch use the same public terminal-body composition as ordinary terminal views. Its documented mode restrictions still apply; this does not introduce private xterm access to bypass those restrictions.

Copy gives priority to the actual official terminal selection. Without a selection, it reads the **existing adapter-observed** screen and retained scrollback. That read does not attach another socket, claim input, resize the terminal or call the unrelated machine TerminalHost text endpoint. The result checks the display ID, source Hub, source session, machine and original `terminalId`. The dialog shows its capture time, adapter sequence, any replay limitation, and whether the local text limit was reached. It can reveal earlier retained rows in batches and select or copy the displayed text.

This is a bounded reconstruction from the source’s replay tail. It is not an authoritative full Runner history snapshot, and output discarded before the adapter observed it cannot be recovered.

## Verification

The focused cases in [client-legacy-terminal-view.test.ts](../tests/client-legacy-terminal-view.test.ts) use the published official `ClientTerminals` factory, public `RemoteStream`, actual Cordis isolation and an explicitly simulated remote wire. They check exact source binding; independent inventory/environment; ordered input and detach-only holds; aborted admission followed by remount; late refresh after tab removal; legacy close refusal and ordinary close delegation; identity-checked adapter text snapshots; and strict restoration of inactive-tab addresses.

The additional [legacy slot lifecycle test](../tests/client-legacy-terminal-slot.test.ts) uses the published official `SlotRegistry` and real Cordis plugin scopes. It checks that body/title registrations keep the service receiver, survive an original plugin reload, and disappear with their own plugin scope. This covers a registration failure found by the first actual browser run.

The focused terminal input, snapshot and public slot lifecycle tests also exercise the shared official-model control path. The replaced custom terminal input helper and its old isolated tests have been removed. All **33** workspace controller cases pass, including delayed-catalog restoration of terminal, document and plugin resources followed by real user navigation.

The updated [browser scenarios](../e2e/legacy-terminal.spec.ts) pass **2/2** against the actual official DSH Web, body and title, consecutively in the final isolated run with Chromium 156.0.8078.4. Both scenarios finish with zero browser page errors.

| Scenario | Verified behavior |
| --- | --- |
| Original terminal controls and lifetime | Exact original source admission; one official terminal/control view; physical input and sticky/one-shot modifiers; command rejection preserves the draft; explicit reload does not resend input; real xterm font changes; custom macros survive reload; 450 retained rows are copied without another attach, input or resize; pane close detaches without a close request |
| Two sources and plugin navigation | Two original sessions with the same `terminalId` remain isolated; the original title rename action works; terminal → official Files → source document → reload → retained inactive terminal → document → Conversation → reload → re-expanded document → reload all preserve the resource’s original source and terminal identity; the 1:2 split remains intact; both pane closes send no termination |

The second scenario reads the persisted workspace after each navigation step. It asserts the original terminal resource kind, Hub, source session and terminal ID together with the actual selected target, rather than accepting a still-mounted but hidden conversation as evidence of restoration. Both scenarios also assert that no machine TerminalHost command was used for these old terminals.

An earlier run stopped during the second scenario because its local DSH Host ceased accepting connections while input was being sent. The source received only the accepted input prefix and the UI reported disconnection; it did not replay the remainder. That run did not retain process-exit diagnostics, so its cause remains undetermined. The same built artifacts subsequently passed the unchanged second scenario alone and then both scenarios consecutively. The harness now includes sanitized Host process output and exit/signal diagnostics. These reruns are verification evidence, not a claimed fix for the unexplained process exit.

The Socket.IO source in [legacy-terminal-fixture.ts](../e2e/legacy-terminal-fixture.ts) is explicitly simulated. Browser results verify real official components, authentication carriers and protocol integration; they do not execute a shell or validate an existing user’s live PTY. Ordinary machine TerminalHost results are recorded separately in [the workbench document](feature-parity-workbench.md).
