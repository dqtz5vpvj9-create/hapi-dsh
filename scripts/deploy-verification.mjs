/** Read-only release checks shared by client-only and Host publication. */
export class DeploymentBuildMismatch extends Error {}

/**
 * The official client route adds a source-map trailer to the completed bundle.
 * Host identity comes from its authenticated, uncached bootstrap response;
 * reading an on-disk client alone cannot identify the running Host process.
 */
export async function verifyDeploymentBuild({ launch, headers, localClient, expectedHostBuildId }) {
    if (!Buffer.isBuffer(localClient) || !localClient.length) throw new Error('A completed local client bundle is required for release verification');
    const read = path => fetch(new URL(path, launch), { headers, cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    const page = await read(launch.origin);
    await page.arrayBuffer();
    if (!page.ok) return { ready: false };
    const bootstrap = await read('/hapi-dsh/bootstrap');
    if (!bootstrap.ok) return { ready: false };
    const payload = await bootstrap.json();
    const graph = payload.graph;
    const entry = graph?.entries?.find(entry => entry.id === 'hapi-dsh');
    if (typeof entry?.url !== 'string') return { ready: false };
    const asset = new URL(entry.url, launch);
    if (asset.origin !== launch.origin) throw new DeploymentBuildMismatch('The client build cannot be verified from a different origin');
    const bundle = await read(asset);
    if (!bundle.ok) return { ready: false };
    const served = Buffer.from(await bundle.arrayBuffer());
    if (!served.subarray(0, localClient.length).equals(localClient)) {
        throw new DeploymentBuildMismatch('The completed client build did not reach the active release; history smoke would test a stale client');
    }
    const trailer = served.subarray(localClient.length).toString('utf8');
    if (trailer && !/^(?:\r?\n)?\/\/# sourceMappingURL=[^\s\u2028\u2029]+(?:\r?\n)?$/.test(trailer)) {
        throw new DeploymentBuildMismatch('The served client adds executable bytes beyond the completed workspace bundle');
    }
    let hostIdentity = { status: 'not-requested' };
    if (expectedHostBuildId !== undefined) {
        if (typeof payload.hostBuildId !== 'string' || payload.hostBuildId !== expectedHostBuildId) {
            throw new DeploymentBuildMismatch('The running Host build identity is missing or does not match the completed workspace build');
        }
        hostIdentity = { status: 'verified', buildId: payload.hostBuildId };
    }
    return { ready: true, clientRevision: entry.rev, hostIdentity };
}
