# Draft upstream PR: allow a Session to commit its composer after sink acceptance

## Problem

An ordinary composer submit starts its default sink and immediately clears the draft. A sink that must persist a local submission first can reject before taking ownership, yet asynchronous error delivery allows the editor and draft persistence to observe an empty document. Restoring a saved copy afterwards can race with new typing.

## Proposed optional capability

Add `ISession.inputCommitPolicy?: 'after-acceptance'`. InputHub forwards this property to its existing input shell. With the property set, the submit machine emits the default sink alone and commits the original semantic draft only after the sink succeeds. Ordinary Sessions keep the existing optimistic path and concurrent sends.

An opted-in input allows editing while serializing submit gestures until acceptance settles. Successful acceptance removes an unchanged submitted prefix and preserves appended text. A rewritten document or a replaced reference remains in the editor. Failure leaves the current draft and attachment rail untouched. Attachment-only acceptance removes only the admitted IDs. Disposal aborts the local attempt and makes late settlement inert.

Acceptance is defined by the sink owner. A durable local outbox may accept before a remote connection exists; this API does not require waiting for execution or a network acknowledgement. Authorization, native queues and operation identity remain outside the composer.

## Compatibility and validation

The property is optional and the default path is unchanged. The implementation can be disabled independently with `globalThis.__DSH_CLIENT_INPUT_ACCEPTANCE = 'off'` before shell construction. No second editor or renderer is introduced.

Contracts execute pinned DSH InputHub, SessionInputShell with real Lexical, and ConversationController. They use actual browser Storage quota failure at the Session admission boundary and inspect the editor DOM, published revisions and operation calls. They cover local refusal, retry, acceptance, double clicks, concurrent editing, semantic-reference preservation, unsupported attachment/reference preparation, disposal and default/disabled compatibility. Live browser and mobile keyboard validation are separately scoped.

This document is a reviewable proposal only. No changes have been sent to the upstream repository.
