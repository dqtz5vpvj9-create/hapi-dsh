# HAPI DSH integration

## Goal

Build a distributable DSH plugin composition with one cross-machine session sidebar, the HAPI tmux-style workspace, official DSH Conversation for all supported sessions, and native Codex thread execution through the existing HAPI bridge.

## Constraints

- Do not edit, patch, monkey-patch, or vendor a modified DSH implementation. Use supported plugin registrations, providers, slots, and profile configuration.
- Preserve native Codex thread identity, original execution ownership, native queue, final approval resolution, and reconnection semantics.
- Closing a pane releases a view and must not terminate its native execution.
- Keep all engines and machines in one sidebar. Do not use separate machine applications or an iframe per machine.
- Reuse official DSH Conversation and plugin infrastructure; do not create another generic chat renderer or plugin manager.
- No secrets, user data, installed credentials, or private configuration in source, examples, tests, commits, or logs.
- A claimed integration must execute against the pinned upstream version; tests using fakes must be identified as such.
- The user explicitly authorizes implementation, a new public GitHub repository, and publication of the result. No changes to upstream repositories are authorized.

## Collaboration

- Work only in the files assigned to your task; coordinate shared contracts with the root agent.
- Leave each component typechecked and tested for its meaningful failure modes.
- Keep dependencies exact and record upstream provenance and licenses.
