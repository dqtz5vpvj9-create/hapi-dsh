# HHPI source extension installation

This procedure builds and installs the optional official DSH reading extensions in a development checkout. It does not deploy a site. Verification results and remaining release acceptance are recorded in [the implementation checkpoint](hhpi-implementation-checkpoint.md).

## Pinned inputs

- DSH release: `0.2.1-rc.3`.
- DSH source revision: `1f81c047fc48fa190a683e469daa699857e9afe8`.
- Source build package manager: `pnpm@11.28.5` with the pinned upstream lockfile.
- Verified runtime: Node 24.19.0, Linux x86-64, git, tar and npm.
- Source inputs: `source-snapshots/dsh-ext/source.patch`, delivered source overrides and the `scripts/dsh-ext` source transformations. `prepare.mjs` records their checksums.

The complete set contains eleven packages under `@deepseek-ai/`: `dsh-api-session-controller`, `dsh-client-ui-slots`, `dsh-client-ui-renderer`, `dsh-client-ui-session`, `dsh-client-ui-conversation`, `dsh-client-ui-chat`, `dsh-client-ui-trajectory`, `dsh-client-ui-tool`, `dsh-client-ui-plan`, `dsh-client-ui-input-trigger`, and `dsh-client-ui-commands`. The history detail packages cover readers outside Chat; Input Trigger and Commands resolve each pane's retained binding so Slash, popups and composer input stay pane-local while legacy consumers keep canonical lookup. Ordinary registry packages carrying the same rc version do not contain these extensions. The installer rejects incomplete or mixed sets.

## Build and install from the checkout

```sh
npm ci
mkdir -p .tmp
node scripts/dsh-ext/prepare.mjs .tmp/hhpi-source > .tmp/hhpi-source.json
DSH_SOURCE=$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(".tmp/hhpi-source.json", "utf8")).directory)')
node scripts/dsh-ext/build-extension.mjs "$DSH_SOURCE" .tmp/hhpi-extension-packages
node scripts/dsh-ext/install-extension.mjs .tmp/hhpi-extension-packages
HHPI_DSH_SOURCE="$DSH_SOURCE" node --import tsx --test \
  tests/contracts/hhpi-reading-occurrences.test.ts \
  tests/contracts/hhpi-reading-dom.test.ts
npm run check
```

The package output directory must not already contain tarballs from a previous build. A fresh output path preserves the earlier set and avoids mixing builds. Preparation creates an isolated source directory and requires no operator DSH profile, production credentials or original author's workspace.

The official Typert source generator runs before the official TypeScript project-reference build. Packages use the pinned upstream compiler preset. Source transformations are applied before compilation; compiled JavaScript is not rewritten to implement an extension.

The installer validates the entire manifest before invoking npm: exact package names, unique filenames, archive checksums, pinned upstream revision and matching patch-set markers. It subsequently verifies installed package identities and records `.tmp/hhpi-ext/installed.json`.

Tracked `package.json` and `package-lock.json` remain unchanged. This explicit source overlay is separately identified by its manifest and archive hashes. Running `npm ci` restores the unextended dependency baseline, so the complete extension set must be installed again before testing direct HHPI reading occurrences. This is a development-checkout installer, not an atomic production rollout mechanism.

The same verified set may be installed in another checkout:

```sh
node scripts/dsh-ext/install-extension.mjs /absolute/path/to/package-set /absolute/path/to/checkout
```

Host and Runner installations must preserve matching source-extension inputs. A matching version string is insufficient: `upstreamCommit`, `patchSetSha256`, every archive checksum and installed package markers identify the actual set. This command does not update remote machines.

## Reading capability and default behavior

`windowCommit.readingOccurrences:1` enables independent official reading/input bindings. Each occurrence retains its canonical native Session ID, with a separate view ID for the reading window and local presentation stores. The native Session continues to own send, cancel and approval operations.

Setting `globalThis.__DSH_CLIENT_READING_OCCURRENCES = 'off'` before graph construction disables direct-source occurrence admission. Native DSH bindings without a view ID retain their ordinary event-feed and per-Session input paths. Missing extension capability produces an explicit error rather than a fallback to an incorrect reader.

## Validation boundaries

`tests/hhpi-extension-install.test.mjs` uses synthetic archives to verify rejection before installation. The installed-extension workflow separately compiles and installs the real eleven-package set, tests actual official Session/Conversation/Input Trigger/Commands/Chat ownership, runs project types, all behavior tests, history and fault checks, and builds the plugin. Source-build caches are keyed by exact source inputs; the package identity check still runs on every installation.

The reading contracts use the actual official renderer and view/input implementations. Source RPC and unused external services are controlled fixtures. Component geometry in jsdom does not establish real-browser scrolling, viewport layout, physical keyboard behavior or desktop/mobile release acceptance. Those remain separate bounded acceptance scenarios.
