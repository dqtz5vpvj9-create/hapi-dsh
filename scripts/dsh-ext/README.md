# Matching Web shell and extension releases

The npm Web shell embeds platform modules such as `SlotCore`. Updating dynamic
UI extensions does not replace these embedded modules. A source extension
release that changes their contract must ship a shell from the same prepared
upstream source and patch set.

After building the extension SDK, build the official shell:

```sh
node scripts/dsh-ext/build-web-shell.mjs "$prepared_source" "$sdk_release" "$fresh_output"
node scripts/bundle/pack.mjs --ext-release "$fresh_output" --out "$bundle_output"
```

The prepared source needs its frozen workspace dependencies and built client
types (`tsc -b packages/client/web/tsconfig.json`). The script uses the Web app's
own Vite version and configuration, resolving platform packages to that source.
It omits the separate browser-worker preview, preserves product isolation checks,
and records source hashes, build inputs, licenses and the resulting package hash.
It never modifies compiled JavaScript or patches the running page.

**Deploy the same SDK composition to the display Host and every connected
Runner.** Adding the shell changes the package-set identity; an old Runner is
correctly rejected until updated. Stage both sides before activating them, retain
the previous matching pair, and verify the authenticated original Host route
after restart. Do not bypass identity checks to make a mixed release connect.

Browser acceptance must open an old canonical native-session link and inspect
its visible source surface and composer, in addition to checking a newly opened
Remote pane. Both paths must render without Slot errors; a local read-only
shadow is not evidence that the owning Remote Host is usable.
