import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

/** Source identity shared by full builds and client-only development rebuilds. */
export async function buildIdentity() {
    const fingerprint = createHash('sha256');
    async function includeSources(directory) {
        for (const name of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = `${directory}/${name.name}`;
            if (name.isDirectory()) await includeSources(path);
            else if (name.isFile()) { fingerprint.update(path); fingerprint.update(await readFile(path)); }
        }
    }
    await includeSources('src'); await includeSources('config');
    for (const path of ['package.json', 'package-lock.json', 'scripts/build.mjs', 'scripts/build-identity.mjs', 'scripts/client-bundle.mjs']) {
        fingerprint.update(path); fingerprint.update(await readFile(path));
    }
    return JSON.stringify(fingerprint.digest('hex'));
}
