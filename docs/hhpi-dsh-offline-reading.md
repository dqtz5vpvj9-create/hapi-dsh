# DSH source reading during an owner outage

Native DSH history is read from the configured official persistence root. After
the original owner has verified a native session identity, paging and following
that local log reuse the verification for up to fifteen minutes. They no longer
fetch the entire HAPI owner catalog before every page or one-second history poll.
The HHPI gateway continues checking the current caller's exact session grant
before and after each read and stream publication.

Successful catalog refreshes update verification. An advertised owner deletion,
changed native locator, ambiguous ownership, or explicit authentication rejection
invalidates the corresponding cached identity. A temporary detail failure retains
only an already verified, unexpired row; it does not hide healthy sessions or
authorize a new native identity. Once the read lease expires, further reads wait
for a successful owner confirmation. Already displayed browser content is owned
by the reader and is not cleared by that wait.

Source writes retain their existing fresh owner, active-turn and approval checks.
The reading cache never resumes a session, acquires a writer handle, or authorizes
an operation. Closing the source releases only its read connection and cache.

`tests/hhpi-dsh-adapter.test.ts` uses real pinned DSH persistence with synthetic
owner HTTP. It reads six earlier pages and receives a native append during an
owner outage without another HTTP request, then verifies that a write performs
fresh owner validation. `tests/hhpi-dsh-owner.test.ts` covers lease expiration,
unknown identities, partial detail failures, deletion and explicit revocation.
