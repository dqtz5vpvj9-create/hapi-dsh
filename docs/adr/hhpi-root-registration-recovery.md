# Observe replacement roots after a registration gap

Status: implemented against DSH `0.2.2-rc.1`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`; source-bearing SDK integration and browser acceptance remain separate.

Disposing an already mounted root registration previously made `RootOutlet` throw its boot-order error. React then removed the application tree and its registration observer, so registering a valid replacement could not restore the application. The controlled regression reproduces the absent replacement through the production renderer.

Keep the outlet subscribed during an empty registration interval after that exact host has mounted a root. Revoke the retired registration and show the existing localized loading surface until the host supplies its replacement. Initial registration state belongs to the exact `SlotRendererHost`; switching hosts requires the new host's own initial root and isolates later mutations of the old host. Missing initial registrations, all-abdicated registered roots, other assembly errors and ordinary component supervision retain their existing behavior.

This change owns only view lifecycle in `@deepseek-ai/dsh-client-ui-renderer`. It adds no global exception handler, timer retry, native operation or execution restart. An independent draft owner remains alive while its registered view is replaced; the source change does not establish the cause of a historical blank Settings page.

The related source suites pass 93 cases, including the actual webApp bundle roster, Client Modules/Loader replacing the layout entry, repeated registration gaps, late old disposers and host replacement. Remote services and the draft owner are explicit fixtures. The package-face TypeScript check also passed. Existing `runInject` binding and store behavior was already in `.22`; this change only updates its obsolete single-argument test assertion.
