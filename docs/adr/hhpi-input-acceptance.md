# Optional composer commit after local acceptance

Status: implemented as a generic L2 source extension of pinned DSH `1f81c047fc48fa190a683e469daa699857e9afe8` (`0.2.1-rc.3`).

## Problem and decision

The ordinary official composer emits the default sink and a draft commit together. `ConversationController.sendSession` is asynchronous, so a synchronous exception from `Session.beginSubmission` becomes a rejected promise. An unavailable or full local outbox can therefore clear the editor and its autosave before the failure handler restores a copy. Restoration can also lose a race with subsequent typing.

Add one optional Session property, `readonly inputCommitPolicy?: 'after-acceptance'`. InputHub passes the policy to its existing per-binding input shell. The shell and its existing submit machine retain the original text, reference occurrences and attachment rail until the ordinary sink reports success. A failure never clears or restores the opted-in draft. It keeps whatever the user currently has in the editor.

The waiting attempt serializes send actions for that input shell while leaving text editing available. Repeated clicks or Enter cannot create another attempt from the retained draft. Success removes only the unchanged submitted prefix, leaving an appended suffix. A replacement or interleaved edit survives intact. A reference in that prefix must still have its original occurrence identity, source and reference; matching clipboard text alone cannot consume a replacement reference. Attachment-only acceptance removes the admitted attachment IDs without clearing text entered while waiting. Releasing the shell aborts its local attempt and ignores late settlement.

## Ownership and compatibility

The sink's success means that its recipient has taken ownership of the submission. HHPI opts in because its browser outbox accepts ordinary text only after durable local persistence. That acceptance must return without waiting for connectivity, a Host receipt, native queue execution or a model answer. The outbox and source operation ledger continue to own delivery, identity, retry and reconciliation. The composer does not become an execution queue or an authorization owner.

Sessions without the property retain DSH's optimistic clearing and concurrent ordinary submissions. Claimed command routing and its existing frozen transaction remain unchanged. `globalThis.__DSH_CLIENT_INPUT_ACCEPTANCE = 'off'` before input-shell construction independently disables this extension, even for an opted-in Session. Removing the feature is a compatibility fallback; a durable-outbox caller must retain its normal failure recovery when the feature is disabled.

The public Session field is optional. The additional commit-effect attempt is package-internal coordination that identifies the semantic draft being retired. There is no DOM interception, alternate editor, runtime patch or compiled-bundle rewriting.

## Delivery and verification

`scripts/dsh-ext/input-acceptance.mjs` transforms only the pinned Session contract and official Conversation input sources. Every replacement verifies its expected source boundary and parses the resulting TypeScript. `prepare.mjs` applies the transform and includes its SHA-256 in `hhpi-source-inputs.json` and the patch-set identity. The source extension is built and installed with the existing complete verified package set.

`tests/contracts/hhpi-input-acceptance.test.ts` executes the actual pinned InputHub, Lexical-backed SessionInputShell and ConversationController. The Session admission endpoints are synthetic boundaries. A real jsdom Storage quota refusal exercises the synchronous-throw-to-rejected-promise path. Assertions observe the editor DOM, every published draft revision, durable storage and admission calls. The contracts cover failure without any transient empty draft, a corrected retry, success, repeated clicks, editing during acceptance, replacement drafts, unavailable attachments/reference owners, disposal, the default DSH behavior and the disable switch.

This is in-process composer behavior evidence. It does not establish browser geometry, a mobile software keyboard, physical-device behavior or delivery to a live native source. Those acceptance layers remain separate.
