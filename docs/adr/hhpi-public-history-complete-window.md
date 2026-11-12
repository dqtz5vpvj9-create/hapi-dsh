# Preserve complete windows through public Session readers

Status: implemented against DSH `0.2.2-rc.1`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`; included in the `.23` source-bearing SDK cohort.

The optional public history source registry selects its owner once for a Session generation, including the choice of the original ordinary stream. A later registration must not change an already open ordinary Session to provider-only navigation while its original stream remains live.

Forward complete-window mode, publication acknowledgement and region refresh through the per-view release wrapper, retaining each provider method's receiver. The default Session reader consumes complete initial windows, navigation reads and deltas as full replacements, acknowledges the exact accepted source version, and serializes candidates with navigation. It restarts follow from that accepted version through the same provider connection. Gap recovery uses region refresh; a later retain after failed recovery refreshes that connection and retains the accepted body. Page providers keep prepend semantics.

Cancellation belongs to the exact feed and generation. A late candidate discards only its captured feed/version and cannot update another generation or clear its loading state. Releasing an old view cannot remove its replacement, and cancelling one retain waiter cannot release another caller's shared opening. These changes stay within `@deepseek-ai/dsh-api-session-controller`; HHPI wire and V1 method fields retain their existing definitions.

The final 13 public contracts cover wrapper forwarding, complete replacement, cursor/version adoption, region refresh and retry, fixed owner selection, ordinary/page behavior, late-candidate discard and shared retention. The applicable 126 ordinary Session/service/ownership regressions and package-face types passed. Remote and provider sources are explicit fixtures; missing test-support declarations were generated privately from actual project settings. SDK integration and real browser behavior are recorded separately, and the historical blank-body screenshot's cause remains unknown.
