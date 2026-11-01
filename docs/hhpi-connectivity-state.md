# HHPI connection and native execution state

The mobile client treats temporary loss of connectivity as recoverable availability.
`SourceSession.connection` carries `online` or `offline` independently from the
last native execution state, active turn, pending native requests and capabilities.
Its `observedAt` changes only on a connectivity transition; routine polling does
not create a new source history revision just to advance a wall clock.

New adapters retain the last execution state across outages. Legacy peers with
`status: offline` are still accepted. A missing catalog row is an availability
observation, not proof that execution stopped or that a capability was revoked.
The gateway retains last-known descriptors while independently refreshing sources.
Explicit access denial continues to remove cached authorization and fails closed.

The ordinary composer uses the durable HHPI outbox before clearing submitted
input. Offline sources therefore permit local submission and show delivery state.
An online source that explicitly declines the send capability and existing native
execution-ownership restrictions still block that operation. Source dispatch
revalidates permissions and ownership; cached capabilities never authorize writes.

Approvals and steering remain bound to their exact native request and turn.
They stay visible but disabled during source outages. Receipt uncertainty is a
waiting status. Definite rejection retains an actionable error. No queued control
is silently transferred to another turn when connectivity returns.
Cancellation also rejects a disconnected entry locally without publishing a
prompt failure or queuing the old turn; an explicit later request checks the
then-current turn. The fresh DSH owner check rejects disconnected writes even
when a retained display descriptor advertises a native capability. Reused owner
locators never carry execution or approvals between different native identities.

Verification uses the real gateway, DSH owner adapter, Codex adapter and production
composer/approval components with synthetic transport failures. The tests assert
retained running/turn/capability state, delayed native settlement, unchanged
metadata on repeated polling, and zero offline approval dispatches. Physical
radio transitions and mobile process termination require separate evidence.
