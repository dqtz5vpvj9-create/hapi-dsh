# HAPI / TermBeam terminal accessory provenance

These browser accessories adapt the pinned HAPI commit
[`0f8ef6970884c92fb2ddca3070be2ec56cb50333`](https://github.com/dqtz5vpvj9-create/hapi/tree/0f8ef6970884c92fb2ddca3070be2ec56cb50333/web/src/components/Terminal/termbeam).
HAPI's original AGPL-3.0-only headers and the independent TermBeam MIT notice
are retained. The MIT license is distributed in
[docs/licenses/TERMBEAM-MIT.txt](../../../docs/licenses/TERMBEAM-MIT.txt).

The HAPI source records TermBeam at
[`0e0cec40284130a5a91a259354d96fe92eb1fd53`](https://github.com/dorlugasigal/TermBeam/tree/0e0cec40284130a5a91a259354d96fe92eb1fd53).

| Local file | Pinned HAPI source / earlier origin |
| --- | --- |
| `defaultKeys.ts` | `termbeam/defaultKeys.ts`; TermBeam `TouchBar/defaultKeys.ts` |
| `keyCombo.ts` | `termbeam/keyCombo.ts`; TermBeam `CustomKeysModal/keyCombo.ts` |
| `TouchBar.tsx` | `termbeam/TouchBar.tsx`; Haven layout and TermBeam pointer repeat |
| `styles.ts` | `termbeam/TouchBar.module.css`, adapted to inherited DSH theme variables |
| `KeyEditor.tsx`, `havenLayout.ts`, `keyCatalog.ts` | HAPI's Haven browser port; see [HAVEN.md](HAVEN.md) |
| `locales.ts` | HAPI `web/src/lib/locales/en.ts` and `zh-CN.ts`, terminal accessory strings |
| `types.ts` | HAPI terminal key and modifier contracts |
| `preferences.ts`, `input.ts`, `dialog.tsx`, `clipboard.ts`, `snapshot.ts` | This integration's public DSH view / workspace adapters |
| `view.tsx` copy paging; Host `hapi/terminal-text.ts` wrapping rule | Adapted from pinned HAPI `termbeam/SelectOverlay.tsx`; the source transport and read-only decoder are this integration's adapters |
| `gestures.ts` | Pinned HAPI `termbeam/terminalGestures.ts`; lazy touch capture, pinch bounds/debounce, normal-buffer momentum and cancellation are adapted to the retained official body |

`source-terminal-actions.tsx` uses DSH's public keyed slot shadowing. The original
Terminal component, its injected face, theme, connection state, xterm renderer,
output acknowledgements and attachment lifecycle remain in use. A new public
input facade delegates every hardware key, touch key, repeat, macro, command and
paste to that same `TerminalView.write`. No second shell, input owner or terminal
renderer is created. Hiding or closing a workspace pane releases a view; it
never calls the explicit terminal termination method.

The two original HAPI preference keys are exposed by the workspace's explicit
shared-preference capability. All unrelated DSH stores remain graph-isolated.
Preferences are validated, and failed browser storage is shown as an error while
retaining the current view's customization.

Copy uses the original terminal's standard DOM copy event for its current
selection. For a source-owned terminal without a selection, it requests one
retained screen snapshot through a separate authenticated HAPI machine viewer.
Pinned HAPI `attach` reads its replay without acquiring control; `claim` is a
separate command and is never sent by this reader. Closing the reader releases
only its own connection. This does not call DSH `terminal.attach`, which assigns
control to its caller.

The Host decodes the original serialized screen with the public buffer API of
`@xterm/headless@6.0.0`, with no input callback. The browser shows a plain-text
copy accessory, initially 200 logical lines, preserving scroll position as older
lines are revealed. It explicitly reports source retention as unknown and local
truncation. A failed read never falls back to a control attachment. Its public
RPC cancellation is signalled on close, hide and disposal.

Ordinary DSH terminals keep their original selection and the explicitly labelled
visible-row fallback. The original component does not expose its xterm buffer:
this integration does not access private emulator fields or claim that visible
rows contain unrendered scrollback.

Touch pinch changes only the occurrence's public theme hook, which the original
Terminal component uses to resize its actual font and grid. The original
9–32 px bounds, 50 ms debounce, 4 px lazy drag capture and normal-buffer inertia
are retained. Transient pinch size does not overwrite the shared font preference.
Wheel events pass through the original screen DOM and its own viewport/mouse
handlers; no private xterm handles or second renderer are used. A mode observer
uses public output frames, and admits motion only after the original renderer
acknowledges the matching frame. Unexpected oversized mode sequences block
gestures until a full reset or source snapshot restores known state. New touches,
hidden views, cancellation and disposal stop momentum.

The pinned body does not expose `scrollLines`. When a program enables mouse
wheel reporting in the normal buffer, a wheel event would become program input
instead of history scrolling. This combination has an explicit translated
availability message; touch history motion is consumed without injecting
application input. A normal buffer configured without scrollback also admits
no synthetic wheel. Alternate-buffer drags use the renderer's actual mouse or
cursor encoding and never acquire momentum. This remaining API limitation is
not described as exact equivalence to HAPI's direct `scrollLines` call.

No TermBeam server, tunnel, login, voice or agent-management service is bundled.
