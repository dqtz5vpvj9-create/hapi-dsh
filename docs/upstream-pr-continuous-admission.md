# Draft: optional admission accounting for continuously retained history

No upstream pull request has been submitted.

An official complete-window reader currently stops once accumulated history exceeds its opening envelope, even if each page is valid and the virtualizer mounts only a small range. Add an optional `WindowCommitHostV1.capacityScope()` returning `growth`, and optional candidate `nodeKeys` containing all stable derived Context identities. Legacy hosts continue enforcing absolute window limits.

For a growth host, count only new/revised source entries and newly admitted derived Context keys relative to the last published transaction. Keep opening limits, genuinely oversized new pages, token provenance, cancellation, source revisions, measurement failures and anchor-retention rejection. A candidate does not acquire admission credit until its publish succeeds. The actual official assembler supplies its Context keys rather than inferring capacity from row-count subtraction.

The implementation is a pinned source transformation in `scripts/dsh-ext/reader-publication.mjs`. Its default/growth behavior and long-history live revisions execute against the real coordinator and assembler in `tests/contracts/hhpi-official-history.test.ts`. Rationale and retention ownership are recorded in `docs/adr/hhpi-continuous-admission.md`.
