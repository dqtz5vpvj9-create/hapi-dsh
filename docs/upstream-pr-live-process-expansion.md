# Add optional automatic disclosure for an active process group

A presentation consumer can group an externally paged live Turn, but currently cannot expand only the active process. History mode keeps earlier processes flat until Turn completion; collapsed mode also collapses the active process.

Add `liveProcessExpansion?: boolean` to the presentation policy and consumer choice. The native group seat derives its initial/automatic visibility from the existing group's `data.closed`, with explicit user choices taking precedence. The option is off when omitted. Ordinary responses close the preceding process while the Turn remains active. Group identity, member parents and reading anchors are retained.

Validation includes the real ChatView, group assembler, process store and native renderer. It covers successive processes separated by ordinary responses, stable group identity, automatic open/close and manual choices surviving later changes. Existing native ChatView and process-group suites verify the default path. This is a local PR draft; no third-party publication is authorized.
