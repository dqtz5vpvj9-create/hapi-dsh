/** Fast client-only compile. The running official Host publishes its supported HMR event. */
import { buildIdentity } from './build-identity.mjs';
import { buildClientBundle, buildSourceProvider } from './client-bundle.mjs';

const started = performance.now();
const identity = await buildIdentity();
await buildClientBundle(identity);
await buildSourceProvider(identity);
process.stdout.write(`Client bundles rebuilt in ${Math.round(performance.now() - started)} ms; Host code and declarations were not rebuilt.\n`);
