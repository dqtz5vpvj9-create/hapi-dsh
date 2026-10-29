# Codex 0.165 compatibility

HAPI-DSH is validated with Codex CLI 0.165.0. It observes the native Codex
session already owned by HAPI and does not launch a second `codex app-server`.

Codex 0.165 can publish a new paginated thread before its first rollout file
exists. HAPI normalizes that state to a successful empty history page.
HAPI-DSH keeps the same display generation for that empty source and attaches
the first user and assistant messages when they arrive.

The compatibility contract is covered by the
`native empty opening accepts a first prompt without archive replacement`
test in `tests/codex-native.test.ts`.
