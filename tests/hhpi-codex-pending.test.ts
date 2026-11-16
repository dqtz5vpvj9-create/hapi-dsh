// The pinned Remote runtime owns this native behavioral contract.
// Reuse its suite in HHPI's release gate rather than maintaining a divergent copy.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
await import(pathToFileURL(join(dirname(require.resolve('@dsh-remote/native-runtime/package.json')),
    'tests/hhpi-codex-pending.test.ts')).href);
