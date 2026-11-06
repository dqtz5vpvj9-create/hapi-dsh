# DSH 0.2.2-rc.1 compatibility

The base is official commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`.
HHPI keeps its existing wire protocol, source ownership and native conversation.
The previous rc's sources and build transformations are archived under
`source-snapshots/dsh-ext/releases/0.2.1-rc.3`.

The active patch consolidates the previously approved history reader, occurrence,
window commit, input binding, optional live-process disclosure and upload-provider
extensions against this rc. It no longer replays the old input-acceptance
transformation: the native `BeginSubmissionInput.onAccept` owns composer acceptance.
HHPI calls that callback after durable local admission, and retains exact operation
identities for owner receipt reconciliation. The native complete image reference
is passed to `SessionFace.readAttachment`.

Image selection timing belongs to native Conversation. Its background uploader
calls the optional `uploadImage` method of the existing Session-addressed
`FileUploadProvider`. The HHPI provider optimizes oversized images on the browser
before calling the existing HHPI upload endpoint. Small originals are unchanged.
The real source receipt travels in the prompt's existing file-receipt list; the
source resolves supported raster uploads to native Codex `localImage` input.
There is no second image upload on send and no remote compression step. A matched
provider's refusal never falls through to the local DSH Agent. With no provider,
the official DSH upload path is unchanged; removing registration disables routing.

The old `inputCommitPolicy`/`admitted` signal and its disable-switch behavior are
retired. Tests now cover native onAccept, refusal, serialized clicks and stale
settlement, alongside source receipt isolation and local preparation before
transport. Native running status precedes pending steering, and native bounded
process scrolling remains available. HHPI's optional live-process policy still
opens current work and closes work before an ordinary reply.

Node/jsdom contracts, pinned source compilation and native component tests do not
prove a physical phone keyboard or the unresolved continuous-history 80 ms gate.
Release checks retain their existing separate acceptance boundaries.

The new core Session store requires enter/announce before append. Source Agent
factories finish initial history preparation, check the source revision, enter
and announce through the official store, and then publish observed state. Child
and root factories retain their existing rollback disposers. Projection
registrations are awaited and disposed through their new handles. The source
Agent model face reads the observed selection and rejects local ownership; model
changes continue through the existing source settings path.

Host index injections now receive Connection.browserPeer after the existing
authentication checks. The Session routing wrapper forwards the new passive event,
state and wait methods with the same current Invocation and upstream metadata.
The native attachment API now takes the complete image reference, including
verified dimensions and byte length. Its official read no longer requires image
membership in the display log; HHPI source resource reads still enforce their
existing source-session and accepted-transcript grants. Tests replace the retired
native log-membership premise with full-reference validation and retain all source
grant, epoch revocation and late-response checks.
