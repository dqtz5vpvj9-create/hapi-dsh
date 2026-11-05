# Password login

The display Host optionally reads `server.loginPasswordFile`, an absolute path to a private UTF-8 file containing the access password. Keep that file outside the repository, restrict it to the service owner (0600), and restart the Host after changing it. The final newline is ignored; other password characters are preserved. Runners do not mount these routes. Profiles without this option retain their existing behavior.

An anonymous request to `/` displays a small password form. A successful same-origin POST to `/login` uses the supported Connection `authenticatedUrl` / `authorizeIndex` exchange entirely on the server. The browser receives the existing authority-bound, signed HttpOnly cookie and a clean redirect. Neither the password nor the launch token is put into browser HTML, a redirect URL, local storage, or an application bundle. Existing launch URLs remain usable. Protected HTTP and WebSocket routes retain their original Connection admission checks.

The authenticated index uses the installed official frontend index, `webServer.renderIndex`, and the same relative base as the official static frontend. The named root/index routes are registered through the WebServer plugin API; other static assets and API routes retain their current owners. No DSH package or HHPI wire contract is changed.

Open `/login` while signed in to return to the workspace or sign out. A link is also available in the workspace link settings. Sign out requires an authenticated same-origin POST, expires the official cookie, and navigates away from the current workspace. It does not terminate native executions or revoke already admitted connections in other tabs. Cookie lifetime and TLS attributes remain owned by Connection.

The login form accepts only same-origin URL-encoded POSTs with a bounded body. Thirty incorrect attempts within one minute temporarily block further password attempts on this Host. Existing signed sessions and token URLs are unaffected. The form has no third-party dependencies or scripts; its policy blocks framing and cross-origin form targets. Production access should continue through the existing HTTPS endpoint.

Reference: local HAPI `web/src/components/LoginPrompt.tsx` and `hub/src/web/routes/auth.ts`: password-style secret input, visible failure state, server-side validation, and exchange for a session credential. HHPI reuses its existing DSH cookie rather than adopting HAPI JWTs or local token storage.

`tests/host-password-login.test.ts` checks anonymous isolation, incorrect/correct password behavior, Host/Origin rejection, bounded input, duplicate fields, throttling and logout with a Connection boundary fixture. Production verification must additionally exercise the installed Connection cookie and real browser form navigation; the fixture does not prove upstream signing behavior.
