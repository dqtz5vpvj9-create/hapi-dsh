# Optional native live process expansion

The HHPI Pane used history-only grouping. Native Chat consequently kept every process flat until its entire Turn ended, even after an ordinary response had already closed an earlier group. The group assembler already publishes the right per-process `closed` state; no HHPI event or lifecycle conversion is needed.

The approved change adds optional `liveProcessExpansion` to `client-ui-chat` presentation choices. With grouped rows enabled, an untouched open group expands and closes when its own `closed` state becomes true. An explicit user choice takes precedence for the lifetime of that mounted group. Omission preserves the native default. HHPI chooses this policy with whole-Turn folding disabled and stable grouped rows retained.

The native group, header actions, member parents, row retention and registered reading anchors remain the owners of presentation. No DOM click simulation, alternate transcript renderer or compiled-output rewrite is introduced. Native Chat tests exercise a live Turn with ordinary responses between processes, stable group identity and manual choices; existing grouping and view tests cover the unchanged default. A complete release retains the other source packages and replaces only the source-built Chat archive, with corresponding source included.
