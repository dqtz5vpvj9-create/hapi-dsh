# Paired Host lifetime during network interruptions

A paired Host's connection observation does not own its workspace lifetime.
An offline catalog row retains the existing official graph, panes, readers,
editor state and Session references. Recovery updates discovery on that same
graph; it does not bootstrap replacement conversations.
Catalog request failures update connection/discovery status without repeating
a global error toast on every background poll.

The workspace catalog now exposes optional `hostsComplete`. The Hub publishes
`true` only after successfully reading its complete pairing policy. A failed
policy read still closes authenticated Runner transports and denies access,
but publishes `false`; the browser can preserve already received views while
the policy becomes readable again. A legacy response without this field is
also non-authoritative for removals.

Only a missing Host in a complete pairing inventory, or explicit workspace
disposal, releases the graph and its references. Removal also drops that Host's
catalog rows. A bootstrap already in flight is aborted and a late result is
disposed without reporting readiness. Native executions remain owned by their
source engines throughout.

The controller and federation lifecycle contract test covers two open panes,
offline and incomplete inventories, same-instance recovery, and authoritative
revocation. The HTTP/WebSocket transport tests separately retain fail-closed
authentication and check the inventory marker. These are synthetic boundary
tests; they do not claim a physical mobile-network measurement.
