# Allow embedding shells to own Workspace startup selection

`ui-workspace` currently restores a selection or connects a blank as soon as the workspace and Session lists become ready. An embedding shell may already have its own saved panes or an explicit conversation target, while still needing the public Workspace navigation and actions. The default restoration can then call `sessions.create` for an unrelated blank before that shell opens its target.

Add optional client `Config.restoreSelection`, defaulting to `true`. Setting it to `false` disables only the startup restoration watcher. Explicit New Session, connect and open remain available, and disposal still releases the final view. The default DSH application behavior is unchanged; no transport, persistence or Session creation contract changes.

Validation covers the default blank connection, zero implicit creation at startup and after catalog updates with the option disabled, explicit New/connect/open and reference cleanup, and forwarding the public apply configuration into the service. HHPI consumes the option through ordinary Loader entry configuration, with its original DSH Session owner retained.

This is an upstream PR draft. No third-party branch or PR has been pushed.
