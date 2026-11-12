# Preserve Contexts when a complete-window body grows after a dependency prefix

A complete-window feed can retain an old dependency ahead of its visible body. Growing `[turn/start #1, body #100]` to `[#1, body #50, #100]` currently replaces the assembler because the new body falls between the first and last retained sequence. This reconstructs unchanged Contexts and their nodes on every older-page publication.

Send monotonic additions before the old tail through the existing `prepend` implementation, which sorts inputs and replays affected Contexts. Continue appending new tail entries. Changed or removed retained entries still use replacement. The complete-window transaction, reader validation and correction remain unchanged; other feed modes retain their current behavior.

The production history-view contract checks a retained dependency prefix, original node identity, candidate-only Context reconstruction, a real retained-event revision, and removal. The previous implementation fails the resident identity assertion. Related grouping, viewport and window-commit source tests remain required. A real browser trace motivated the change; the release's 2 px and 80 ms acceptance limits still require a separate installed-package run.
