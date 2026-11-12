# Draft upstream PR: preserve complete history through public Session readers

Target: `packages/api/session-controller`, pinned upstream `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` (`0.2.2-rc.1`). This is a draft; nothing has been pushed upstream.

The per-view wrapper currently drops complete-window mode, publication acknowledgement and refresh. The default Session reader also treats complete windows as prepend pages, and a late provider registration can change navigation for a Session whose original stream is still active.

Retain provider methods and receivers through the wrapper; accept exact complete versions before replacing the public event window. Serialize navigation and follow publication, recover gaps by refreshing the current region, and preserve the accepted body through failed recovery. Fix provider selection for each Session generation, including the original-stream choice. Keep cancellation and discarded candidates attached to their captured feed/generation. Page providers preserve their existing prepend behavior.

Validation covers public ClientSessions registration/retain, explicit views, full-window replacement, acknowledgement ordering, region refresh and retry, ordinary/page readers, late registrations, exact late-candidate discard and shared retention lifetime. The final public contracts, applicable ordinary Session/ownership regressions and package-boundary types pass. Providers and remote services are explicit source fixtures.
