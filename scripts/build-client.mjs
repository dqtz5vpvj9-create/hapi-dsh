/** Fast client-only compile. The running official Host publishes its supported HMR event. */
import { buildIdentity } from './build-identity.mjs';
import { buildClientBundle } from './client-bundle.mjs';

const started = performance.now();
await buildClientBundle(await buildIdentity());
process.stdout.write(`Client bundle rebuilt in ${Math.round(performance.now() - started)} ms; Host code and declarations were not rebuilt.\n`);
