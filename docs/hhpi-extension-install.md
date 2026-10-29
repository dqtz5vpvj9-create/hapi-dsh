# HHPI source extension installation

This procedure builds and installs the optional DSH source extensions in a development checkout. It was exercised by the installed-extension integration workflow at HHPI code revision `24541313db51c9b9ca499ff4bb0deaf64cf8e798`. It does not deploy a site or establish final HHPI browser acceptance; current product gaps are recorded in [the implementation checkpoint](hhpi-implementation-checkpoint.md).

## Pinned inputs

- DSH release: `0.2.1-rc.3`.
- DSH source revision: `1f81c047fc48fa190a683e469daa699857e9afe8`.
- Source build package manager: `pnpm@11.28.5` with the pinned upstream lockfile.
- Required runtime for this checkout: Node 24.19.0 or a compatible later 24.x; the verified environment was Linux x86-64 with git, tar and npm.
- Source patch inputs: `source-snapshots/dsh-ext/source.patch`, delivered source overrides where present, and the `scripts/dsh-ext` source transformations. `prepare.mjs` records their checksums.

The installed set contains `@deepseek-ai/dsh-api-session-controller`, `@deepseek-ai/dsh-client-ui-conversation` and `@deepseek-ai/dsh-client-ui-chat`. Ordinary npm packages carrying the same rc version do not contain these extensions.

## Build and install from the checkout

```sh
npm ci
mkdir -p .tmp
node scripts/dsh-ext/prepare.mjs .tmp/hhpi-source > .tmp/hhpi-source.json
DSH_SOURCE=$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(".tmp/hhpi-source.json", "utf8")).directory)')
node scripts/dsh-ext/build-extension.mjs "$DSH_SOURCE" .tmp/hhpi-extension-packages
node scripts/dsh-ext/install-extension.mjs .tmp/hhpi-extension-packages
npm run check
```

The package output directory must not already contain tarballs from a previous build. A new output path preserves the earlier set and avoids mixing builds. `prepare.mjs` creates an isolated source directory and does not require an operator's DSH profile, production credentials or the original author's workspace.

The official Typert source generator runs before the official TypeScript project-reference build. Packages are then built with the pinned upstream compiler preset. No compiled JavaScript is rewritten to implement an extension.

The installer first verifies the entire manifest and package set. It rejects missing or duplicate packages, unexpected filenames, checksum mismatches, the wrong source revision and archives with a different or absent patch-set marker. Only after validation does it invoke npm. It then verifies the actual installed package markers and writes `.tmp/hhpi-ext/installed.json`.

The bootstrap `package.json` and `package-lock.json` are retained unchanged. Extension installation is an explicit local overlay, separately identified by the manifest and package checksums. Running `npm ci` again restores the unextended dependency baseline; the complete extension set must then be installed again before building or testing HHPI source-window features. The installer is a development-checkout installer, not an atomic production rollout mechanism.

The same verified package set can be installed into another checkout:

```sh
node scripts/dsh-ext/install-extension.mjs /absolute/path/to/package-set /absolute/path/to/checkout
```

Host and Runner installations must use matching source-extension inputs. A matching rc version string alone is insufficient. The manifest's `upstreamCommit` and `patchSetSha256`, all three archive checksums, and the installed package markers identify the actual set. Packaging and site deployment must preserve that set; this command does not update remote machines automatically.

## Validation boundaries

`tests/hhpi-extension-install.test.mjs` uses synthetic package archives at the filesystem boundary to test rejection before installation. `.github/workflows/hhpi-integration.yml` separately builds and installs the real source packages, runs full types and behavior checks, exercises history/fault contracts, and builds the plugin. These two forms of evidence have different scopes.

The official npm rc packages continue to support backend tests that do not require Client extensions. A passing backend lane does not establish a valid Client installation. Browser scrolling, per-Pane draft ownership, native source operation feedback, desktop/mobile layout and physical-device behavior remain separate acceptance requirements.
