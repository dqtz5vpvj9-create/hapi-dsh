# Enter preference on the official composer

The original `hapi-composer-enter-behavior` preference is read from the shared workspace preference owner. Existing `newline` values take effect in local and remote pane graphs. Missing, invalid, or `send` values retain DSH's original keyboard behavior. Settings → **Message input** changes the preference for every pane. Returning to the default removes the original key. A browser storage failure keeps the change active in the current page and displays a save error.

## Behavior and ownership

| Gesture or state | New line preference |
| --- | --- |
| Enter | Let the native `beforeinput` event replace the current selection with one line break through the unchanged official editor, preserving its caret, undo and semantic persistence. |
| Ctrl+Enter / Cmd+Enter | Use the official ordinary `InputActions.submit` queue path, preserving command adjudication, claims and attachment ownership. |
| Shift+Enter | Leave the original editor's line break behavior in control. |
| Open completion menu | Let the public `InputTriggerController` choose the highlighted candidate. Its public Down gesture selects the first ready row when no row is highlighted. Pending refinement consumes the key without selecting stale data or sending the raw query. |
| IME confirmation | Leave the event with the browser and official editor during composition, legacy key code 229, and the 10 ms composition-end guard used by pinned DSH. |
| Held Enter | Consume repeated keydown events without a second pick, newline, or send. |
| Alt / AltGraph / Ctrl+Cmd / modified Shift combinations | Leave the original editor and application shortcut owners in control. |
| Read-only, removed, blocked, adjudicating, submitting, or hidden pane | Do not insert or submit. The real editable surface and public composer block/state remain authoritative. |
| Empty draft with no files | Do not submit or steer the existing queue. |
| Pending, failed, or unavailable attachment owner | Keep the draft and attachments; report why submission is unavailable. |
| A different Session generation during candidate arbitration | Cancel the key without editing or submitting through a stale owner. |

The default **Send message** preference leaves the original DSH Enter, queue/steer preferences, candidate handling, and accelerated shortcuts unchanged. The normal Send button is unchanged in either preference.

An additive `conversation.input.right` slot supplies a seat in the exact official composer card. Its native capture listener sees only that card's `data-composer-input` surface. It does not install a document-level shortcut, replace the composer, mutate its DOM, access Lexical internals, or import package-private `ComposerKeyboard`/`ComposerBarInjected` operations. Selection, file and session chips, undo history, default-send settlement and commands remain under the official owners.

For an admitted plain Enter the capture listener stops only keydown propagation, bypassing the original Enter-to-send handler while retaining the browser's native editing default. The original Lexical `beforeinput` handler receives `insertParagraph` and its plain-text owner creates the proper line-break node and trailing caret support. It does not synthesize a keyboard/input event or use `execCommand`. Candidate picks, repeated keys, blocked input and Ctrl/Cmd submission all prevent that native default. This matters at the end of a chip or paragraph: inserting a raw LF through the asynchronous text API leaves Chromium's caret before the trailing LF, which puts subsequent typing on the wrong line.

Attachment readiness is observed through the existing `SourceComposerBridge` around the real `conversation.input.attachments` presentation slot. Inspection requires the exact public `inputActions` identity and requested attachment IDs. A file is ready only when its original published upload state contains a completed receipt. The Enter adapter never starts, retries, removes, serializes, or claims an attachment itself. Unsupported third-party attachment renderers with their own inject/store/child ownership remain unavailable for this observation; their editor and attachment presentation remain intact.

`installShareReceiver` already owns or receives the one attachment bridge for every full, local pane, and ordinary remote graph. It installs `installComposerEnter(ctx, bridge)` once and disposes it before disposing its own bridge. Preferences come from `ctx.hapiWorkspaceUi`; no graph creates a competing preference store.

## Verification

Targeted runtime tests: `node --import tsx --test --test-isolation=none tests/client-composer-enter.test.ts tests/workspace-ui-preferences.test.ts` — **16 passing tests** after the native line-break correction. These cover the admission matrix, candidate arbitration, failed arbitration, exact Session generation changes, attachment receipt states, original-key migration and failed storage writes. Event and attachment owners in these tests are explicit fixtures.

`e2e/composer-enter.spec.ts` passed **2/2 actual browser tests in 26.4 s** against the coordinated build containing the native line-break correction, with Chromium 156 and one worker. The tests exercise the unchanged official Web profile, real Lexical editor, Undo, file candidate menu and chip, upload owner, separate remote graph and reload. The first test verifies exact selection replacement, chip-preserving newline delivery, IME confirmation, held-key protection, Shift+Enter and restoration of the default Send preference. The second holds a real official upload request, checks the original pending/error controls and portal-based Toast, releases the request and verifies one delivery, then restores both local and remote drafts after reload and verifies exact single-LF source delivery. No page errors were observed. Both final screenshots were reviewed.

The first browser run exposed the trailing-LF caret defect; retaining the native `beforeinput` default fixed it without altering upstream. The native HAPI delivery endpoint and deliberate upload transport delays/failures remain explicit fixtures. Chromium's real composition engine is driven with a raw Enter keydown, composition commit, and keyup; an ordinary Playwright Enter also emits a separate CR character that a real IME candidate confirmation consumes. This verifies the browser event sequence, not manual validation on a particular desktop OS IME or mobile keyboard. Reload is checked through the original restored paragraphs and exact source message: Chromium's `innerText` inserts two visual LFs between paragraphs although DSH's semantic projection retains one LF.

Reproduction:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium-156/chrome-headless-shell \
  npx playwright test e2e/composer-enter.spec.ts --workers=1
```

Client and E2E TypeScript checks passed. No browser build overrides or source changes to DSH/HAPI are required.

## Upstream references

- Original HAPI [preference storage and defaults](https://github.com/dqtz5vpvj9-create/hapi/blob/55166cf8d87814ccfb383b538a8e8c55283bed81/web/src/hooks/useComposerEnterBehavior.ts) and [composer keyboard behavior](https://github.com/dqtz5vpvj9-create/hapi/blob/55166cf8d87814ccfb383b538a8e8c55283bed81/web/src/components/AssistantChat/HappyComposer.tsx).
- Pinned DSH `packages/client/ui-conversation/src/client/contract/input.ts`, `contract/composer-blocks.ts`, `contract/slots.ts`, and `input/editor/keymap.ts` define the public actions, public admission states, attachment seat and original IME/repeat behavior.
- Pinned DSH `packages/client/ui-input-trigger/src/client/contract.ts` and `controller.ts` define public controller resolution and arbitration. `ComposerKeyboard` and the input bar's injected implementation face remain package-private and are not used by this plugin.

All DSH references are to release `0.2.1-rc.2`, commit `687f282e8625c6b8d11ff58211a90524be2e4317`, recorded in `UPSTREAMS.json`.
