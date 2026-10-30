# HHPI browser and simulated-DOM verification

Date: 2026-10-30. Branch: `feat/hhpi-remote-access-20261029`.

Validated code: `05ac81bc15a3e46f9177d11f06c1cea8742e4e41`. Browser workflow run `41001945294`, job `123888131776`, completed both scenarios successfully. Installed-extension integration run `41001945272`, job `123888131574`, also completed all applicable checks successfully. Main and production were not changed.

## Observed results

Environment: Ubuntu 24.04.5, Node 24.19.0, Playwright 1.56.1, real Chromium 141.0.7390.37. The installed nine-package DSH source-extension fingerprint was `eb66f4f35e382d9052f373f53c50e16d79b5f905e88a27d5581b8fc5dc6165fb`.

| Measurement | Desktop | Mobile emulation |
| --- | --- | --- |
| Viewport | 1440 x 900 | 390 x 844 |
| Complete journey | Passed in 5,536 ms | Passed in 17,042 ms |
| First usable official view | 974 ms | 962 ms |
| Six earlier visible content segments | 160 to 1,120 retained rows | 160 to 1,120 retained rows |
| Other Pane retained rows | 160 throughout | 160 throughout |
| Six stationary-commit anchor displacements | All 0 CSS pixels | All 0 CSS pixels |
| Anchor acceptance threshold | 2 CSS pixels | 2 CSS pixels |
| Cached round trip and three cached-tail gestures | No additional source read | No additional source read |
| Browser keydown / keyup samples before final submit | 17 / 17, all trusted | 17 / 17, all trusted |
| Composing Enter | One observed, no submission | One observed, no submission |
| Final ordinary Enter | Exactly one canonical synthetic send | Exactly one canonical synthetic send |
| Gesture samples | 23 trusted wheel events | 141 trusted touchmove events |
| Console/page errors and unexpected external requests | None | None |
| Observed animation-frame interval p95 | 16.8 ms | 16.8 ms |
| Maximum observed frame interval, including startup | 116.7 ms | 116.7 ms |

Browser component assembly took 553 ms after dependency and source-extension installation. The journey timings exclude CI machine preparation, dependency installation and browser download. They are one bounded CI execution, not a comparative benchmark.

The simulated-DOM lane passed four contracts: desktop and mobile official component mounting, independent reading/input ownership, and rejection of manufactured or capability-disabled bindings. Three focused geometry-observer regressions also pass. The installed-extension workflow passed official reading/input contracts, Host/Client/component typechecks, the full behavior suite, history/fault contracts, plugin build and tracked dependency-input consistency. Source compilation was restored from its exact-input cache; it is not counted as a new compilation in these runs.

## Executed implementations

`tests/contracts/dom-geometry.ts` provides scoped jsdom geometry profiles, explicit element boxes, resize notifications, selection rectangles and bounded React-layout flushing. Every override is restored on disposal. The desktop and mobile contracts execute the installed official Renderer, SessionProvider, Conversation, Chat, mounted controls and editable input. The geometry utility is never imported into a browser or production entry.

`tests/browser` is a separate real-Chromium component lab. It serves unchanged installed official client bundle bytes, verifies the nine-package source-extension identity, and uses official styles. Production HHPI Session adapters, reading occurrences, shared cache and seamless paging execute unchanged. The two-pane outer shell, settings, source RPC and operation sink are explicit fixtures. The source uses the production SourceEventIndex with 1,440 synthetic variable-height messages, including Chinese text and long unbroken lines.

The browser lane does not patch DOM geometry. One component build and one Chromium process serve two fresh isolated contexts. Each journey has a 60-second deadline without retries. Only loopback fixture requests are accepted.

## Input and measurement contracts

Each journey opens the real body/editor, checks horizontal overflow and editor hit testing, preserves independent drafts in two occurrences, reads six earlier visible body segments, revisits cached content, returns to latest, performs three cached-tail gestures, and submits exactly one correctly addressed synthetic native operation through the official keyboard path.

Keyboard coverage includes trusted keydown/keyup, Shift+Enter, Chinese insertion, focus changes, browser composition state, composing Enter without submission, and a subsequent ordinary Enter submission. Composing raw keys and IME text commitment are dispatched separately. No JavaScript-created KeyboardEvent is used. The observed compositionend has `isTrusted: false`; that value is retained in the report. Browser-protocol composition is distinct from a physical OS input-method candidate window.

Anchor samples are taken through an observational participant at the official window-commit checkpoint. The observer never owns admission or writes scroll state. Request-time displacement is retained separately. Missing anchors fail, and all six stationary-commit displacements must remain within 2 CSS pixels.

For mobile anchoring, a trusted contact approaches outside the 600-pixel load runway, crosses it on its final move, and remains stationary through the commit. This separates a prepend jump from intentional finger movement. Cached traversal uses twelve frame-paced touch moves. Initial positioning to 900 pixels is an explicit native scrollTo inside accepted content; it is not claimed as a touch traversal through the entire cached page. This bounded scenario does not certify arbitrary uninterrupted inertial movement across a concurrent commit.

Earlier failed runs remain available: run `40999992540` established passing desktop behavior and exposed mobile displacement while the driver continued moving; run `41000756828` exposed the incorrect carriage-return composition sequence; run `41001174245` passed composition but still mixed intentional touch movement with the stationary-anchor assertion. The final run uses separate raw-key/text-commit operations and an explicitly stationary boundary-crossing protocol. No production paging behavior, error assertion or two-pixel threshold was removed to obtain a pass.

## Evidence and review

Workflow artifact `12953168988`, `hhpi-browser-evidence-05ac81bc15a3e46f9177d11f06c1cea8742e4e41`, contains the unmodified report and both browser traces. The uploaded archive SHA-256 is `ed7a44f822cd22c184111ae0b053b87c4ebd50f08c4002670c60bfb755d5ed84`; workflow retention is seven days.

The JSON report records `physicalKeyboard`, `physicalPhone`, `operatingSystemIME` and `softKeyboard` as `not-run`. Its automatic `visualReview` field remains `not-performed`. After execution, one desktop and one mobile trace frame were visually inspected separately: message bodies and the bottom composer were visible, with no apparent horizontal clipping in those selected frames. This limited inspection does not certify all intermediate layouts or subjective scrolling quality. Reviewed frame resource names:

- Desktop: `page@99dc1e157162ddd9c4f47bba31cd9545-1793333889637.jpeg`.
- Mobile: `page@f687e7f6217ef04e4d99981321ac0fad-1793333906926.jpeg`.

Physical phone hardware, physical key switches, OS IME candidate selection, mobile soft-keyboard viewport resizing, production Host/Runner pairing and production deployment were not executed. A successful browser-protocol test is not relabelled as a physical-device result. Frame statistics are observations from a shared CI worker, not a universal 60-fps or subjective smoothness guarantee.

## Reproduction

After installing the verified source-extension set and setting `HHPI_DSH_SOURCE` to its prepared source checkout:

```sh
node --import tsx tests/browser/run.mjs --dom
node --import tsx --test tests/hhpi-browser-probe.test.ts
node --import tsx tests/browser/run.mjs --browser
```

Browser-tool installation, `--serve` and `--headed` are documented in `tests/browser/README.md`. Reports and traces are written under `.tmp/hhpi-browser/results`. They contain synthetic session content only.
