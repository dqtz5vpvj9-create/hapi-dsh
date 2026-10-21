# Existing HAPI SessionTerminal panes

An imported HAPI workspace with `schemaVersion: 2` may already contain a terminal
ID backed by the original session-scoped terminal protocol. This terminal stays
attached to that original HAPI session and terminal ID. It is not converted into
a machine TerminalHost, and opening the pane does not create a replacement shell.

## Protocol and lifetime

[`legacy-session-terminal.tsx`](../src/client/legacy-session-terminal.tsx) keeps
the existing browser terminal and replay cursor. The authenticated bridge in
[`terminal.ts`](../src/hapi/terminal.ts) verifies the source Hub, session and
machine before forwarding the original `terminal:create`, `terminal:write` and
`terminal:resize` protocol. Input requires source readiness and compatible
version 1 replay; a gap or disconnected transport blocks input.

The source remains responsible for the PTY and its idle policy. A browser reload
reattaches the same terminal. Closing a pane disconnects its viewer and never
emits `terminal:close`. Failed or uncertain writes are not replayed after the
connection returns. A browser socket accepting bytes is not represented as proof
that a shell executed them.

## Shared controls and preferences

The compatibility view now reuses the project's existing HAPI-derived `TouchBar`,
`KeyEditor`, `TerminalPreferences` and dialog components. These provide the saved
two-row toolbar, custom keys and escape-sequence macros, snippets, layout editing,
one-shot modifiers, locked Ctrl/Alt modifiers, hold-repeat, clipboard paste and a
separate command input. Command drafts clear only after the existing socket
accepts their bytes. A failed admission leaves the draft available.

The small adapter in
[`legacy-terminal-input.ts`](../src/client/legacy-terminal-input.ts) sends through
that same session-scoped connection. Touch keys read the real xterm application
cursor mode. Physical input is already encoded by xterm. Paste observes the real
bracketed-paste mode, and repeated keys retain their captured modifier sequence.
An ordinary output chunk does not clear a locked modifier; loss of the source
connection or hiding the view clears armed modifiers.

The workspace shares the original `hapi-terminal-touchbar-keys`,
`hapi-terminal-toolbar-settings` and appearance preferences across its panes.
The original `hapi-terminal-font-size` preference supplies the base font.
Changing a key layout or that base font updates the existing view without
replacing its connection. View zoom remains local. Copy in this compatibility
view uses the original xterm selection; the separate machine TerminalHost text
snapshot and touch-gesture integration are not claimed as SessionTerminal
features by this change.

## Verification

The four cases in
[`tests/client-legacy-terminal.test.ts`](../tests/client-legacy-terminal.test.ts)
pass. They exercise one-shot and locked modifiers, real-mode navigation,
captured repeat sequences, a source-admission or write failure retaining input,
no replay on reconnection, bracketed paste, line endings and exact macro bytes.

[`e2e/legacy-terminal.spec.ts`](../e2e/legacy-terminal.spec.ts) passed against the
unchanged official DSH Web and a real Chromium/xterm instance. It imports an
existing v2 terminal pane and verifies:

- The original source session and terminal ID are used for every attach and
  write; no machine TerminalHost request is made.
- One-shot Ctrl affects only the next character. Locked Ctrl survives both
  subsequent characters and source output until explicitly unlocked.
- Command input submits once to the original terminal transport. A custom macro
  saved outside the toolbar appears in Snippets and survives a page reload.
- Changing the shared font from 9px to 15px keeps the same attachment. Reload
  retains the font and macro without replaying previous input.
- Closing the pane only detaches the viewer. No terminal-close command occurs,
  and the browser reports no `pageerror`.

The test's Socket.IO source is explicitly simulated in
[`legacy-terminal-fixture.ts`](../e2e/legacy-terminal-fixture.ts). It verifies the
real browser, authentication carrier and original protocol integration; it does
not execute a shell or claim validation against an existing user's live PTY.
The machine TerminalHost results are recorded separately in
[the workbench compatibility document](feature-parity-workbench.md).
