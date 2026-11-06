# Draft: preserve retained composer ownership in trigger menus and file picking

Opening the same conversation in an independent Pane gives the editor its own binding, but the trigger menu and file action still resolve by session ID. Clicking Add therefore opens a different controller, and file selection cannot find the mounted shell. Carry the optional binding through the trigger context and use the slot reading owner for menu injection and InputHub file picking. Existing session-ID callers keep their behavior.

Also honor an explicit chat presentation consumer for retained Panes before applying the existing fallback, so official process grouping can be enabled by its owner.

Scope: client-ui-input-trigger, client-ui-conversation, client-ui-chat at 0.2.1-rc.3. Tests cover the retained/canonical menu separation, candidate ownership, existing input service and draft behavior, and chat presentation/virtual rows. This is a draft only; no upstream submission is authorized or performed.
