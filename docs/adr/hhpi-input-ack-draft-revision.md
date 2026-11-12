# Retire only the acknowledged draft revision

Status: implemented against DSH `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` / `0.2.2-rc.1`, pending the coordinator's source-bearing SDK release.

The pinned composer leaves a message in the editor while awaiting acceptance. Its read-only view does not establish that the semantic document is unchanged: a queued native input update or an explicit editor action may still change it. The prior successful sink effect unconditionally cleared that document. A real InputHub/SessionInput/Lexical contract reproduced loss of both an appended phrase and a replacement draft after a delayed acknowledgement.

Capture `draftRev` together with the submitted text, references and quotes. Carry the original attempt into the commit effect. An unchanged revision retains the normal successful-clear behavior. For a changed revision, remove only a strictly appended suffix's original prefix, and only when its reference occurrences and quotes still match the submitted semantic prefix. Keep a rewritten document, replacement reference/quote, or new attachment-only text intact. A refusal does not clear or restore text. Existing attachment settlement removes only the captured attachment IDs.

This belongs in the official editor and submit machine. It does not add an editor, storage fallback, retry, owner, wire method or automatic send. Admission and native queue ownership stay unchanged. No new feature switch is needed for the invariant that an old acknowledgement cannot delete a newer document.

The regression uses the real pinned editor and a controlled admission response. A public `setDraft` update represents the queued input/plugin boundary; it does not establish how any particular operating-system voice keyboard behaved. Range geometry is a jsdom boundary. The reported user's exact trigger remains unconfirmed until the original input/submit evidence establishes it.
