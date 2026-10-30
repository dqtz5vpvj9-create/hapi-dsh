# HHPI official component lab

This lab has two independent evidence levels. `--dom` runs the installed official reading/input/mounted-component contracts in jsdom with declared geometry fixtures. `--browser` runs exactly two serial Chromium journeys using real layout and trusted browser-protocol wheel/touch/keyboard inputs. No geometry methods are patched in the browser.

The browser loads the installed official client bundles byte-for-byte, their official styles, and the pinned browser platform libraries. The production HHPI RemoteSessions, SourceSessions, independent reading scopes, shared page cache and seamless paging controller execute unchanged. The outer two-pane frame, settings/locale service boundary and loopback transport are fixtures. The source uses the production SourceEventIndex with 1,440 synthetic variable-height user messages and seven complete tool/PTC/result lifecycles. Each of the six earlier reads selects 160 contiguous events: 151 user messages and one nine-event tool lifecycle. The audit verifies those exact source ranges and the resulting 154 official Chat nodes (including the assistant step). Visible-body checks select actual user nodes; position measurements select leaf content anchors instead of enclosing groups. This is component integration acceptance, not authenticated Host/Runner discovery, full workspace deployment, or a live Codex model run.

## Execution

The verified eleven-package extension set must already be installed and `HHPI_DSH_SOURCE` must identify its prepared, built source checkout, as described in `docs/hhpi-extension-install.md`.

```sh
node --import tsx tests/browser/run.mjs --dom
npm install --prefix .tmp/hhpi-browser-tools --no-package-lock --ignore-scripts --no-audit --no-fund playwright@1.56.1
node .tmp/hhpi-browser-tools/node_modules/playwright/cli.js install chromium
node --import tsx tests/browser/run.mjs --browser
```

The isolated optional browser tool uses Playwright 1.56.1, Apache-2.0, from microsoft/playwright and the npm registry. It is not a product dependency and does not modify the root lockfile. `HHPI_PLAYWRIGHT_MODULE` may point to an existing compatible Playwright library. The workflow installs browser OS dependencies explicitly. No browser availability failure becomes a skip.

One source-build cache is keyed by all extension inputs. One component build and one browser process serve both fresh isolated contexts. The existing fast DOM command has a 30-second process budget; each browser scenario has a 60-second deadline and no retries. Reports include actual build and scenario times. Failures preserve traces and reports under `.tmp/hhpi-browser/results`; these contain synthetic data only.

`--serve` keeps the isolated loopback lab open until SIGINT, and `--headed` uses a visible desktop browser for interactive diagnosis. Neither option changes the test's evidence category. The fixture rejects foreign origins and unexpected external requests and never reads a production profile or token.

## Bounded scenarios

Desktop uses 1440×900 with two independent occurrences of one canonical source; mobile uses 390×844 with touch emulation and a visible-pane selector. Each checks the first usable body/editor, long-line wrapping, editor hit testing, six earlier visible body segments, isolation of the other reading window and draft, real anchor displacement at each mounted commit, a cached down/up round trip, return to latest and three cached tail gestures. Keyboard checks use the real editable component, multiline input, Chinese text insertion, focus changes and one source-scoped submission to a synthetic operation sink. Sending through keyboard must produce exactly one correctly addressed operation.

Reports separate actual browser execution from simulated device configuration. Frame p95/max are observations from a shared CI runner, not a 60-fps or subjective smoothness guarantee. Anchor correction is accepted only within 2 CSS pixels and missing/blank content fails. Browser traces are retained for inspection; automated geometry does not imply an agent has visually reviewed screenshots.

Physical phone touch, physical keyboard switches, OS IME candidate selection and mobile soft-keyboard resizing are explicitly `not-run`. A desktop browser protocol cannot certify those hardware behaviors. Actual device evidence must retain the device/browser/input method and observed results separately; there is no flag to relabel emulation as physical acceptance.
