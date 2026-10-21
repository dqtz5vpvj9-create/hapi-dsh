/** Browser-safe contracts for exporting the original HAPI Companion pairing link. */
import { z } from 'zod';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';

const id = z.string().min(1).max(512);
const address = z.string().min(1).max(4096);

/** Both pinned native clients identify the Hub by origin; Android requires HTTPS. */
export function companionOrigin(value: string): string | null {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
            || value.includes('?') || value.includes('#')) return null;
        return url.origin;
    } catch { return null; }
}

const origin = address.refine(value => companionOrigin(value) === value, 'Expected a canonical HTTPS Hub origin.');
export const sourceCompanionInfoSchema = z.strictObject({
    hubId: id,
    sourceUrl: address,
    endpoint: z.strictObject({ url: origin, origin: z.enum(['source', 'configured']) }).nullable(),
    unavailableReason: z.enum(['https-required', 'origin-required']).nullable(),
    warnings: z.array(z.literal('loopback-host')),
}).refine(value => (value.endpoint === null) === (value.unavailableReason !== null), 'Endpoint availability must match its reason.');
export type SourceCompanionInfo = z.infer<typeof sourceCompanionInfoSchema>;

export const sourceCompanionRevealSchema = z.strictObject({ hubId: id, endpointUrl: origin });
export type SourceCompanionReveal = z.infer<typeof sourceCompanionRevealSchema>;

/** The entire value of `link` is a credential; never persist it or include it in diagnostics. */
export const sourceCompanionLinkSchema = z.strictObject({ hubId: id, endpointUrl: origin, link: z.string().min(1) }).refine(value => {
    try {
        const link = new URL(value.link);
        const keys = [...link.searchParams.keys()];
        return link.protocol === 'hapicompanion:' && link.hostname === 'bind' && link.pathname === '' && !link.port
            && !link.username && !link.password && !link.hash && keys.length === 2
            && link.searchParams.getAll('hub').length === 1 && link.searchParams.get('hub') === value.endpointUrl
            && link.searchParams.getAll('code').length === 1 && Boolean(link.searchParams.get('code')?.trim());
    } catch { return false; }
}, 'Invalid original Companion link.');
export type SourceCompanionLink = z.infer<typeof sourceCompanionLinkSchema>;

export interface SourceCompanionApi {
    sourceCompanionInfo(): Promise<RemoteResult<SourceCompanionInfo>>;
    sourceCompanionReveal(request: SourceCompanionReveal): Promise<RemoteResult<SourceCompanionLink>>;
}
export const sourceCompanionInputs = { sourceCompanionReveal: sourceCompanionRevealSchema };
export const sourceCompanionOutputs = { sourceCompanionInfo: sourceCompanionInfoSchema, sourceCompanionReveal: sourceCompanionLinkSchema };
