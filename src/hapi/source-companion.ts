import { RemoteError, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '../client-api.ts';
import { companionOrigin, sourceCompanionInfoSchema, sourceCompanionRevealSchema,
    type SourceCompanionInfo, type SourceCompanionLink, type SourceCompanionReveal } from '../source-companion-types.ts';

export interface SourceCompanionOptions {
    hubId: string;
    sourceUrl: string;
    companionUrl?: string | undefined;
    /** The same raw credential used by the original HAPI client, supplied by its owner. */
    readCredential(): string;
}

function denied(status: number, sourceCode: string, message: string): never {
    throw new RemoteError('hapi/request', message, { outcome: 'rejected', status, sourceCode });
}
function requireOwner(invocation: RemoteInvocation | undefined): void {
    // principalOf intentionally returns undefined for both an owner and a call
    // without an invocation. Revealing a credential requires positive proof.
    if (invocation?.peer.principal.kind !== 'owner') {
        denied(403, 'companion_owner_required', 'Only the authenticated Host owner may export Companion credentials.');
    }
    if (invocation.signal.aborted || invocation.peer.signal.aborted) {
        denied(409, 'companion_call_closed', 'The Companion request is no longer active.');
    }
}
function sourceUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error('Companion requires a valid configured HAPI source URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        || value.includes('?') || value.includes('#')) throw new Error('Companion requires a credential-free configured HAPI source URL.');
    return url;
}
function isLoopback(url: URL): boolean {
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host);
}

/** No source mutation, credential storage, pairing claims, or arbitrary-URL network requests. */
export class SourceCompanionService {
    private readonly view: SourceCompanionInfo;
    private readonly readCredential: () => string;

    constructor(options: SourceCompanionOptions) {
        const source = sourceUrl(options.sourceUrl);
        const candidate = options.companionUrl ?? options.sourceUrl;
        const endpoint = companionOrigin(candidate);
        if (options.companionUrl !== undefined && endpoint === null) {
            throw new Error('The configured Companion address must be an HTTPS origin without a path, credentials, query, or fragment.');
        }
        this.view = sourceCompanionInfoSchema.parse({
            hubId: options.hubId,
            sourceUrl: source.toString().replace(/\/+$/, ''),
            endpoint: endpoint === null ? null : { url: endpoint, origin: options.companionUrl === undefined ? 'source' : 'configured' },
            unavailableReason: endpoint === null ? (source.protocol !== 'https:' ? 'https-required' : 'origin-required') : null,
            warnings: endpoint !== null && isLoopback(new URL(endpoint)) ? ['loopback-host'] : [],
        });
        this.readCredential = options.readCredential;
    }

    info(invocation: RemoteInvocation | undefined): SourceCompanionInfo {
        requireOwner(invocation);
        return structuredClone(this.view);
    }

    reveal(invocation: RemoteInvocation | undefined, input: SourceCompanionReveal): SourceCompanionLink {
        requireOwner(invocation);
        const parsed = sourceCompanionRevealSchema.safeParse(input);
        if (!parsed.success) denied(400, 'companion_request_invalid', 'The Companion request is invalid. Refresh its Hub details.');
        const request = parsed.data;
        if (request.hubId !== this.view.hubId) denied(409, 'companion_source_changed', 'The selected HAPI Hub changed. Refresh before revealing its pairing link.');
        if (!this.view.endpoint) denied(409, 'companion_endpoint_unavailable', 'Configure an HTTPS origin for the original HAPI Hub before exporting a pairing link.');
        if (request.endpointUrl !== this.view.endpoint.url) denied(409, 'companion_source_changed', 'The selected HAPI endpoint changed. Refresh before revealing its pairing link.');
        let credential: string;
        try { credential = this.readCredential().trim(); }
        catch { denied(503, 'companion_credential_unavailable', 'The original HAPI credential is unavailable. Check the private Host configuration.'); }
        if (!credential || credential.includes('\0')) denied(503, 'companion_credential_unavailable', 'The original HAPI credential is unavailable. Check the private Host configuration.');
        return {
            hubId: this.view.hubId,
            endpointUrl: this.view.endpoint.url,
            link: `hapicompanion://bind?${new URLSearchParams({ hub: this.view.endpoint.url, code: credential })}`,
        };
    }
}
