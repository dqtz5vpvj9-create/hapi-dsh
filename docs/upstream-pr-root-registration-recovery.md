# Draft upstream PR: restore an application after root registration replacement

Target: `packages/client/ui-renderer`, pinned upstream `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` (`0.2.2-rc.1`). This is a draft; nothing has been pushed upstream.

When a mounted root registration is disposed before its replacement arrives, the current outlet throws a boot-order error and loses its own subscription. A later valid registration therefore cannot restore the application.

Retain the outlet observer during a gap after the same host has mounted a root, revoke the retired entry and display a localized loading surface. Reset initial-registration state when the host changes. Preserve the errors for an empty initial host, registered-but-abdicated roots, other assembly failures and ordinary component supervision.

Validation covers the production Client Modules/Loader replacing the actual webApp layout, two registration gaps, old disposers, host replacement, draft-owner continuity and the renderer package's error behavior. Remote services and the independent draft owner are fixtures; browser rendering and historical-incident attribution remain separate.
