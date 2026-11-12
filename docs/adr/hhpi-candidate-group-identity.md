# Preserve group identity in isolated history candidates

Status: implemented against DSH `0.2.2-rc.1`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`; browser acceptance remains separate.

The continuous-reading browser check exposed a real publication failure. A reader could be anchored to a collapsed process-group header while an earlier page extended that same group. The published Chat assembler preserved the group's identity through `extendedGroup`, but the private window candidate started with empty grouping state and chose the new first member as its identity. The official visible-anchor check then rejected a page that retained the original group and its members. The accepted window stayed readable, but the user could not continue paging.

`ConversationGroupDefinition` now has an optional `fork(context)` method. It returns independently mutable grouping state for a private candidate. The official Conversation candidate builder forks opted-in grouping state before assembling the candidate events. Definitions without this method retain their existing initial-state behavior. Chat's process grouping copies its turn/group maps and mutable group records, while sharing immutable node references and snapshots. Candidate construction or rejection cannot change the published reader.

The existing candidate capacity and visible-anchor checks remain unchanged. A group retains its identity only under the existing business rule: its complete original ordered member run survives together, with newly visible members outside that run. Splitting the group or removing its owner does not create continuity. The exact DOM anchor and source positions remain owned by the official Chat reader. There is no HHPI protocol field, key parsing, alternative renderer, runtime interception, or compiled-code edit.

The source tests exercise the real Conversation candidate/publication path, an independently forked Chat process group, candidate isolation, and rejection when a visible owner is removed. The browser check still requires six earlier visible source segments, the unchanged 2 px physical-anchor limit and 80 ms frame-gap limit, latest return, and cached reading. This source change does not by itself establish those browser results.

The change is archived in the consolidated rc.1 source patch and the `.5` release source offer, together with the [upstream PR draft](../upstream-pr-candidate-group-identity.md). No upstream submission is authorized by this document.
