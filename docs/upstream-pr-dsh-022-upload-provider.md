# Draft: image staging for Session-addressed upload providers

DSH 0.2.2 starts image uploads when files are selected. Existing Session-addressed
file upload providers need the same ownership seam for `uploadImage`, so a remote
Session can preprocess and stage its image with its own source without changing
Conversation's upload timing, progress, cancellation or receipt handling.

Add optional `FileUploadProvider.uploadImage` with the service's existing image
signature. The first matching provider owns both success and failure; absent
image support fails at that owner rather than routing to an unrelated local Agent.
Unmatched Sessions keep the official background upload path. Registration disposal
stops new routing while existing promises retain their owner.

Tests exercise exact argument forwarding, provider failure, absent image support,
and unchanged ordinary DSH transport. The port retains the previously approved
history and occurrence extensions separately from the native input-acceptance
implementation now supplied upstream. This is a local PR draft, not a submitted PR.
