# Public user-file attachment seat

HHPI needs a file card to open its authorized source document. The pinned UserContent rendered file cards as inert spans and exposed only the image child seat. Add the generic session-scoped `conversation.chat.user.file` single Slot with one exact FileAttachmentRef. UserContent preserves attachment order and delegates that leaf only. The official UserFileCard remains the default inert span; removing a consumer contribution restores that same component. No source path, Host identity, fetch, native operation or permission is inferred by Chat.

The HHPI consumer wraps the original leaf component with explicit navigation using its graph's authenticated SourceFileClient. Ordinary DSH leaves the default occupant unchanged. No DOM event interception, alternate UserContent or compiled artifact modification is used.

The extension is necessary because a source-owned attachment is an opaque authority and cannot become a filesystem link. Public SlotTestRuntime tests cover the exact reference, no implicit opening, explicit click and disposal fallback; existing mixed file/image ordering and user row tests remain. The Client ui-chat package typecheck remains required. Source archives retain the public contract and implementation with its original MIT licensing.
