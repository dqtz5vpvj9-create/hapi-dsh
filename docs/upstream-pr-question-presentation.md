# Optional presentation policy for continued questions

Continued questions can remain answerable after their original foreground wait. A client that rehydrates a large history may need to keep a question available in the transcript without publishing every old card into the composer. Add an optional policy for automatic presentation and an explicit user-dismiss callback. Default behavior is unchanged when no policy is installed; the existing panel provider can reveal a hidden card. Distinguish a user closing a panel from the internal hide after sending an answer.

Validation should cover hidden-card reveal, policy changes after a projection update, user close versus answer submission, and ordinary clients with no policy.
