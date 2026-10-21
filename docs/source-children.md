# Original HAPI DSH child conversations

HAPI DSH children appear below their original parent in the unified sidebar and
open in the same workspace panes as other chats. The official DSH Conversation
renders their source text, reasoning and tool records. Their execution stays on
the original HAPI Runner; a workspace pane never starts a replacement Agent loop.

## Continuing a child

For a source child whose original catalog reports `continuable`, use **Use /child
follow-up** beside the official composer, or type `/child` and select its command.
The visible command chip stays in the official editor. Enter the task and use the
official Send button. `/child-steer` explicitly targets the original child's
nearest step instead of queuing a later turn. This source protocol accepts text
only; existing attachment drafts are retained and cannot be silently discarded.

This is a deliberate interaction difference from an ordinary DSH-owned child.
The pinned HAPI `dsh-subagents/:child/messages` endpoint returns a neutral
transcript with ordinal row IDs. It does **not** expose the original prompt RPC
ID. DSH's ordinary composer uses that identity to retire its optimistic message
echo. Passing an accepted response to that default sink would leave a second,
unresolvable message in the conversation. Therefore ordinary text Send for an
HAPI-owned DSH child is refused before submission and preserves the draft. The
explicit command uses the public DSH `CommandClaim` path, which has its own
admission result and does not create a default transcript echo. No chat renderer,
DOM message suppression, invented source invocation, or private input sink is
used.

An accepted command means this Host retained the original submission intent. The
child controls show the separate source receipt: accepted, rejected, or unknown.
Acceptance does not establish execution completion. The original child catalog
owns its running/idle state, and its source transcript owns its actual output.

## Recovery and identity

Each command has a stable browser identity recorded before admission. The Host
journal maps it to a single original source request and retains the immutable
source Hub, HAPI parent, DSH parent, Runner, child ID, and child creation time.
The browser can recover a lost Host acknowledgement by reading that exact local
command identity. It does not compare message text to guess which source history
row consumed the task.

HAPI's source request cache is time limited, so unknown source results never
trigger an automatic retry after reconnect or restart. Reopening the panel only
reads state. **Close local waiting** explicitly abandons a browser wait; it does
not cancel the original task or claim that the task failed. Submitting the same
text as another operation can cause duplicate execution, which the confirmation
explains.

One-shot, external, unknown-mode, Codex child-thread and SDK sidechain observations
remain read-only. They are not made writable by a local descriptor or generic
DSH resume. Original root-session settings, files, terminals and voice controls
are not inherited implicitly by a child. Closing or moving a child pane never
interrupts its original process.

## Compatibility and verification boundary

The adapter targets the unchanged HAPI fork at
`55166cf8d87814ccfb383b538a8e8c55283bed81` and DSH at
`687f282e8625c6b8d11ff58211a90524be2e4317` (`0.2.1-rc.2`). The source protocol
definitions and binding validation are in
[`dsh-child-types.ts`](../src/hapi-agent/dsh-child-types.ts) and
[`dsh-child-protocol.ts`](../src/hapi-agent/dsh-child-protocol.ts). Public DSH
subagent delegation remains in the original package-root service; the routing
provider only intercepts exact registered source-child identities.

Focused tests exercise original protocol schemas, durable request behavior,
Loader readiness, ordinary subagent and Team delegation, and authorization.
Browser tests run the actual official DSH Web, Conversation, editor, gateway and
Agent services against clearly labeled HAPI wire fixtures. They do not constitute
verification against a live model account or the user's production Runner.

### Verified source-child paths

The three cases in [`e2e/dsh-children.spec.ts`](../e2e/dsh-children.spec.ts) passed
against the shared official-Web build used for the current checkpoint:

- The exact original parent, Runner and child remain in one sidebar. Ordinary
  Send refuses the unsupported correlation path and retains the draft; the
  visible `/child` command uses the original editor and Send button, submits
  once, shows the source receipt, and leaves **zero optimistic message echoes**.
- Lost prompt and interrupt acknowledgements remain unknown through page reload.
  Source reads do not resend either operation or invent a source completion.
- A genuinely empty source child uses the public Source state view and can send
  its first explicit follow-up through the same command path.

[`tests/hapi-subagent-controller.test.ts`](../tests/hapi-subagent-controller.test.ts)
also verifies the real Cordis dependency lifecycle. A consumer installed before
the original package finishes loading activates once the public routing provider
is ready, withdraws when the original provider disappears, and returns when the
delegate returns. The wrapper is owned by a public-scope child plugin; the
original package-root manager is constructed only once. Its already-resolved
dynamic configuration is preserved, not validated a second time. Ordinary
subagent methods, the exported Agent Team adapter, caller Invocation and the
official authorization manifest retain their original delegation.
