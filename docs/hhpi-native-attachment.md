# Attach existing native Codex sources

HHPI can run without a legacy HAPI connection. Remove the `hapi` field from the private Host configuration and configure `sources`; keep the existing DSH home, profile, server admission settings and workspace. A source keeps its original machine and native thread identity. Reading does not resume a thread or create a new app-server.

For a daemon on the same Unix account:

```json
{
  "sources": [{
    "id": "native",
    "machineId": "existing-machine-id",
    "engine": "codex",
    "endpoint": "unix:///absolute/private/native.sock",
    "ownership": "shared"
  }]
}
```

The socket must belong to the Host account and have no group/other access. Credential-free loopback WebSocket endpoints also remain supported. In `shared` mode, loaded threads use their existing native owner. Set `writerLock: "native"` in the private source configuration only after verifying that the native server and every other writer sharing its Codex home use compatible cross-process thread writer locks. An explicit send can then request native resume of the same thread. Another live writer rejects the resume; HHPI does not replace that writer or send the prompt after a refusal. Opening, paging and following persisted history never resume it.

HHPI does not infer locking from the server's version or user-agent. Without verified `writerLock: "native"`, shared sources retain loaded-thread controls but cannot cold-resume. Reverify the lock when changing the server or another writer using the same home. The existing `exclusive` option describes an operator-assigned home and retains its explicit-send resume behavior; it does not bypass the native lock. No native execution is resumed by a reconnect alone. Earlier design evidence is recorded in [Codex send recovery](hhpi-codex-send-recovery-2026-11-01.md).

For another machine, use authenticated SSH to run the bundled `dist/remote/native-stdio.cjs` against an existing private socket or Windows named pipe. Configure the source with `command: "ssh"` and an argument array invoking that file through the remote Node executable. On Windows, use an operator-owned PowerShell launcher file so quoting the pipe path is handled on the source machine. The bridge forwards native JSON-RPC over stdio; it closes its own connection when detached and leaves the engine running. It neither starts nor stops a daemon.

Native history uses the source's sparse SQLite item index to select one page before requesting native item bodies. Opening a long thread does not enumerate every turn or rebuild the entire projection. Reopening an unchanged native revision reuses accepted projected events; actual source revisions are checked before reuse.

For a remote Codex home, install the bundled Node 24 helper `dist/remote/codex-metadata.mjs` on the source machine and configure a private `historyMetadata` command alongside the native RPC bridge:

```json
{
  "historyMetadata": {
    "command": "ssh",
    "args": ["-T", "agent-host", "/absolute/path/to/node", "/absolute/path/to/codex-metadata.mjs"]
  }
}
```

HHPI appends `--serve` and reuses this authenticated SSH metadata channel across pages and Panes. The helper reads local native metadata; it does not execute agent commands or resume a thread. Without a reachable sparse index or configured helper, the source reports `HISTORY_UNAVAILABLE` while keeping already accepted history. It does not silently fall back to loading the entire transcript. See [the opening repair](hhpi-opening-repair-2026-11-04.md) for the DSH indexed-reading path and its first-index limits.

Keep a private backup of configuration and workspace before a production cutover. Bind each migrated pane only after matching its original engine, machine and native ID. `draftOrigin` retains the prior display/source identity solely for browser draft recovery; it never routes a new HHPI pane through HAPI. Old draft keys remain available, and conflicting drafts appear in the existing recovery control. Native DSH sessions continue to use their official Host protocol through federation and require a reachable Runner; they are not Codex sources.
