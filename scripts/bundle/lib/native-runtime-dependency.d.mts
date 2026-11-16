export function prepareNativeRuntimeDependency(options: {
    releaseRoot: string;
    manifest: { payload: { hapi: { tarball: string } } };
    fetchPackage?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<string[]>;
