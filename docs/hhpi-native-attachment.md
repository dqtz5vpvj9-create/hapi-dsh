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

The socket must belong to the Host account and have no group/other access. Credential-free loopback WebSocket endpoints also remain supported. `shared` means that native controls are advertised only for threads already loaded by that daemon; opening persisted history does not load the thread for execution.

For another machine, use authenticated SSH to run the bundled `dist/remote/native-stdio.cjs` against an existing private socket or Windows named pipe. Configure the source with `command: "ssh"` and an argument array invoking that file through the remote Node executable. On Windows, use an operator-owned PowerShell launcher file so quoting the pipe path is handled on the source machine. The bridge forwards native JSON-RPC over stdio; it closes its own connection when detached and leaves the engine running. It neither starts nor stops a daemon.

Native directory reads use the app-server state database, and history enumerates body-free turn headers before paging native items. Successful full reconciliation records a completion checkpoint in the source's SQLite index. Reopening the same native revision serves accepted event pages from that index; changed revisions and interrupted builds require reconciliation. A first uncached long thread still needs indexing before it becomes readable.

Keep a private backup of configuration and workspace before a production cutover. Bind each migrated pane only after matching its original engine, machine and native ID. `draftOrigin` retains the prior display/source identity solely for browser draft recovery; it never routes a new HHPI pane through HAPI. Old draft keys remain available, and conflicting drafts appear in the existing recovery control. Native DSH sessions continue to use their official Host protocol through federation and require a reachable Runner; they are not Codex sources.
