# Explicit native queue continuation after interruption

Status: implemented; source/DOM contract verification and publication tracked by `hhpi-stopped-image-queue-20261112`.

The native Codex queue intentionally retains messages after a user interruption. HHPI exposed only active-turn steering in the official QueueDock, leaving an idle retained queue without a usable continuation action. Successful upload or queue admission does not restart execution.

## Public DSH extension

Two packages change: `api/session-controller` adds `QueueAction {kind: "start"}` and rejects it in ordinary commands before resolving an Agent; `client/ui-conversation` adds optional per-row `queueActions.start` and uses the existing row send button. Missing projection/capability preserves ordinary behavior. No HHPI schema or native RPC is changed.

The source explicitly advertises start only when online, idle, writable and `thread/queue/start` is supported. A user click re-reads the exact native row and uses its existing queuedSubmissionId. It does not copy input into another send, delete it first, reorder the queue or automatically resume an unloaded thread. The existing account-owned native action ledger retains one operation; unknown outcomes are read-only reconciled and never blindly dispatched again.

Codex 0.165.0 starts the selected item only while idle and deletes it only on admission. Normal completion subsequently drains remaining items in native order; interruption does not. The button therefore says “发送此条并继续队列”, rather than promising isolated single-item execution. Existing running Steer and transfer-resume semantics remain unchanged. An already submitted typed async-question reply remains the original queue input and settles only when consumed by native history.

The same Session keeps a started row visible until its original client ID reaches body observation. Existing composer pending/official body handoff remains authoritative for locally submitted input. This in-memory start hold does not invent a durable delivered receipt after refresh. Genuine unknown writes retain their original source receipt and are not resent.

## Verification boundary

Focused Session contracts cover idle explicit dispatch, attachments/control identities, native-row/body handoff, concurrent state changes and unknown no-replay. Production QueueDock/ordinary command specs exercise the optional action and default rejection. One unmodified Codex 0.165.0 app-server with the existing synthetic Responses loopback confirms interruption and selected-start/native-drain semantics; no external model or user thread is used. Released browser acceptance is separate.

Primary native semantics: https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/ext/queue/src/service.rs and https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/app-server/src/request_processors/thread_queue_processor.rs .
