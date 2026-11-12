# Draft upstream PR: preserve new editor content after an old acknowledgement

Target: `packages/client/ui-conversation`, pinned upstream `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` (`0.2.2-rc.1`). This is a draft; nothing has been pushed upstream.

An accepted default message currently clears the editor without comparing its submitted revision. A queued input or programmatic edit can update the actual Lexical document before the acknowledgement arrives, causing that newer text to disappear.

The change carries the captured content revision on the existing submission attempt and retires only that document. Unchanged submissions still clear normally. A pure appended suffix survives after an exact semantic-prefix check; replacements remain untouched. Failed submissions keep their current content. Reference/quote identity and captured attachment IDs retain their existing ownership.

Validation: real InputHub/SessionInput/Lexical delayed-success regression, replacement/semantic-quote protection, failure retention, stale settlement/disposal, and the package's named submit-machine suite. No physical speech or browser hardware claim is made. The existing composer and transport APIs remain the execution path.
