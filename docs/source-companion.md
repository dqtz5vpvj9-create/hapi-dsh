# Original HAPI Companion pairing

**Settings → Companion** exports a pairing QR and link for the existing HAPI
iOS or Android application. The native app connects directly to the original
HAPI Hub and continues to use that Hub's authentication, sessions and device
registration. Pairing does not create a Runner, a DSH connection, a chat or a
second source Hub.

This is a compatibility feature for the original native application. It does
not make the native app speak DSH's Remote protocol or display every independent
DSH Host that the browser workspace federates.

## Address and protocol

The link preserves the pinned source protocol:

```text
hapicompanion://bind?hub=<encoded-original-HAPI-origin>&code=<encoded-original-access-token>
```

The token is the same raw CLI access token used by the configured HAPI client,
including any namespace suffix. It is not the client's temporary HAPI JWT or a
DSH/Runner admission credential. URL encoding preserves the opaque token; the
integration does not remove, replace or manufacture a namespace.

Use a phone-reachable HTTPS origin for the original HAPI API. Android rejects
HTTP. Both pinned native clients identify their Hub by origin and discard path
prefixes. The integration therefore does not silently upgrade an HTTP source
URL or remove a configured API prefix.

If `hapi.url` is already a compatible HTTPS origin, the Companion section uses
it. A Host connected to HAPI over a private or local address can explicitly set
`hapi.companionUrl` to that **same HAPI Hub's** reachable HTTPS origin:

```json
{
  "hapi": {
    "id": "my-original-hapi",
    "url": "http://127.0.0.1:3006",
    "tokenEnv": "HAPI_DSH_TOKEN",
    "companionUrl": "https://hapi.example.com"
  }
}
```

This fragment belongs in the existing private Host configuration; keep its
other fields. The optional Companion URL accepts only an HTTPS origin, without
credentials, a path, query or fragment. `server.publicUrl` is the workspace's
address and is not substituted for the HAPI endpoint. A loopback address is
identified in the UI because `localhost` on a physical phone refers to that
phone. Reachability and certificate trust still depend on the actual device
and deployment.

After scanning or opening the link, the original native app asks the user to
confirm the Hub, checks `/health` and the supported protocol version, exchanges
the raw token at `/api/auth`, and stores its credentials. This settings page
only reports that a QR is displayed or that a link was copied. There is no
source endpoint that proves to this page that a device completed pairing.
The original `/api/bind` route is for Telegram binding and is not used here.

## Credential boundary and view lifetime

The Companion section uses the official Settings slot. Its metadata request
returns only the current source Hub, candidate endpoint and compatibility
information. Merely opening Settings or refreshing metadata does not read or
return a token. **Show pairing QR** is the explicit credential export action.

Both Remote methods require a current invocation whose Peer principal is
exactly `owner`. A missing invocation, non-owner principal or disposed call is
rejected. The reveal request must also match the current Hub ID and exact
endpoint before the credential reader is called. Credentials supplied to that
reader and to the HAPI transport come from the same startup value.

The browser produces the QR locally with `qrcode`. No QR-generation service or
arbitrary destination receives it. The complete pairing link stays in the
short-lived settings controller and visible view; it is not added to catalog
projections, operation journals, browser storage, logs or source messages.
Credential-reader failures use fixed, non-secret diagnostics.

**Hide**, leaving the section, closing Settings, hiding the browser page and
unloading the plugin clear the visible link and QR. The public DSH
`connection/reset` event clears them and re-reads source metadata. A view epoch
discards late reveal, QR and clipboard completions; reconnection never triggers
another reveal. Clipboard or QR failures retain an explicit manual-copy path
while the user has chosen to show the link. Hiding the view does not erase an
already copied operating-system clipboard or promise physical erasure of
strings from JavaScript memory.

The link conveys the original Hub credential's access. The source namespace
suffix is an authentication selector, not a cryptographically restricted
delegation. There is no per-conversation read-only invitation, expiration or
revocation token added by this feature. A separate limited live-sharing system
would need its own real principal and resource permissions.

## Implementation and validation scope

- [Browser-safe API](../src/source-companion-types.ts)
- [Owner-gated Host service](../src/hapi/source-companion.ts)
- [Short-lived view state](../src/client/source-companion-state.ts)
- [Official Settings contribution](../src/client/source-companion.tsx)

All nine focused tests pass. They exercise owner and non-owner calls,
absent/disposed invocations, exact source binding, source-address validation,
opaque token encoding, sanitized failures, delayed replies,
connection-generation refresh, explicit copy and hidden-view cleanup.

All three cases in [the browser specification](../e2e/companion.spec.ts) passed
against the unchanged official DSH Web and Chromium 156. The cases verify:

- The official Settings shell reads metadata without returning a credential;
  explicit reveal preserves the original token, renders a locally generated
  PNG that Chromium can decode, and copies the exact link through the real
  clipboard. Browser storage contains no pairing credential. Hiding the link
  or changing the Settings section removes the visible link and QR.
- Hiding the link or closing Settings while an actual reveal HTTP response is
  held cannot let that late response restore its credential to the view.
- An HTTP source without a configured HTTPS Companion origin explains the
  native-app restriction and never requests credential export.

Host, Client and end-to-end TypeScript checks also pass. Connection-reset and
hidden-page invalidation are covered by the focused state tests; the three
browser cases do not claim a separate device reconnect or native-app test.

The browser environment uses an explicitly simulated HAPI source and a reserved
HTTPS alias that receives no network request. It validates browser/protocol
integration and does not claim that a physical iOS or Android device scanned
the QR or completed authentication against a real deployment.
