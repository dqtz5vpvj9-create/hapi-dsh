# DSH source extension versions

The active baseline is official DSH `0.2.2-rc.1`, commit
`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`. `source.patch` contains the
consolidated source changes and contract tests for this rc. Restore with
`scripts/dsh-ext/prepare.mjs`, build all 22 packages with
`scripts/dsh-ext/build-extension.mjs`, then assemble a source-bearing release with
`scripts/dsh-ext/create-release.mjs`. Use upstream's pinned pnpm 11.28.5.

`releases/0.2.1-rc.3/` preserves the preceding rc's patch inputs and build
transformations. The remaining old transformation files are historical material;
the active preparation entry does not replay them over 0.2.2. In particular, the
native onAccept implementation replaces the former input-acceptance extension.
See `docs/adr/hhpi-dsh-022-upgrade.md` for the migration and upload ownership rules.
