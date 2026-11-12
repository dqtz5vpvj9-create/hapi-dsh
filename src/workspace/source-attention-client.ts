/** Host-owned Runner attention client. Only paired federation reads can supply this transport. */
import { z } from 'zod';
import type { FederationHub } from '../hub/federation.ts';
import { parseSourceSessionId } from '../remote/protocol.ts';
import { isSourceDisplayId } from '../shared/source-display-id.ts';
import { appNotificationTargetSchema, appSourceRouteSchema, type AppNotificationTarget, type AppSourceRoute } from './app-service-types.ts';
import type { SourceAttentionSourceFeed } from './notification-events.ts';
import { SOURCE_ATTENTION_PATH, attentionBatchSchema, attentionCatalogSchema, attentionSourceSchema, type AttentionSource } from './source-attention-route.ts';
export type { AttentionSource } from './source-attention-route.ts';
export interface SourceAttentionClient {
    listSources(hostId: string, signal: AbortSignal): Promise<AttentionSource[]>;
    feed(hostId: string, source: AttentionSource): SourceAttentionSourceFeed;
    authorize(hostId: string, source: AppSourceRoute, signal: AbortSignal): Promise<void>;
    locate(hostId: string, source: AppSourceRoute, signal: AbortSignal): Promise<AppSourceRoute | null>;
    requestState(hostId: string, target: Extract<AppNotificationTarget, { kind: 'request' }>, signal: AbortSignal): Promise<'pending' | 'settled'>;
}
const allowedSchema = z.strictObject({ allowed: z.literal(true) });
const stateSchema = z.strictObject({ state: z.enum(['pending', 'settled']) });
function wireSource(hostId: string, raw: AppSourceRoute): AppSourceRoute {
    const source = appSourceRouteSchema.parse(raw);
    if (source.hostId !== hostId || source.kind === 'local-dsh') throw new Error('The attention target belongs to another original Host.');
    return appSourceRouteSchema.parse({ ...source, hostId: 'local', kind: source.kind === 'federated-dsh' ? 'local-dsh' : source.kind });
}
function path(name: string, query: Record<string, unknown> = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, JSON.stringify(value));
    return `${SOURCE_ATTENTION_PATH}/${name}${params.size ? `?${params}` : ''}`;
}
export function createSourceAttentionClient(reader: Pick<FederationHub, 'readApplication'>, options: { pollWaitMs?: number } = {}): SourceAttentionClient {
    const read = async (hostId: string, address: string, signal: AbortSignal) => {
        signal.throwIfAborted(); const response = await reader.readApplication(hostId, address, signal); signal.throwIfAborted();
        if (response.status !== 200 && response.status !== 204) throw new Error(`The original Runner attention service refused the read (${response.status}).`);
        return response;
    };
    const json = (body: Uint8Array) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
    return {
        async listSources(hostId, signal) {
            const response = await read(hostId, path('catalog'), signal);
            if (response.status !== 200) throw new Error('The original Runner did not return an attention catalog.');
            return attentionCatalogSchema.parse(json(response.body)).sources;
        },
        feed(hostId, raw) {
            const source = attentionSourceSchema.parse(raw);
            return { async *attentionEvents(saved, signal) {
                let cursor = saved;
                while (!signal.aborted) {
                    const response = await read(hostId, path('poll', { source, cursor, ...(options.pollWaitMs === undefined ? {} : { waitMs: options.pollWaitMs }) }), signal);
                    if (response.status === 204) {
                        if (cursor === undefined) throw new Error('The source attention service did not admit an initial cursor.');
                        continue; // A bounded idle poll never advances or discards its original cursor.
                    }
                    const batch = attentionBatchSchema.parse(json(response.body));
                    if (!cursor && !batch.reset) throw new Error('The initial source attention batch did not establish its cursor.');
                    if (cursor && !batch.reset && (batch.cursor.epoch !== cursor.epoch || batch.base !== cursor.version || batch.cursor.version <= cursor.version)) throw new Error('The source attention continuation does not match the original cursor.');
                    for (const item of batch.events) {
                        if (source.routeKind === 'hhpi') {
                            const identity = parseSourceSessionId(item.sessionId);
                            if (identity.machineId !== source.machineId || identity.sourceId !== source.id || identity.engine !== source.engine || item.event.position.kind === 'dsh') throw new Error('The Runner attention event belongs to another native source.');
                        } else if (isSourceDisplayId(item.sessionId) || item.event.position.kind !== 'dsh') throw new Error('The Runner attention event is not an original native DSH event.');
                    }
                    signal.throwIfAborted(); yield batch; cursor = batch.cursor;
                }
                signal.throwIfAborted();
            } };
        },
        async authorize(hostId, source, signal) {
            const response = await read(hostId, path('authorize', { source: wireSource(hostId, source) }), signal);
            if (response.status !== 200) throw new Error('The original Runner did not confirm source authorization.');
            allowedSchema.parse(json(response.body));
        },
        async locate(hostId, source, signal) {
            const expected = wireSource(hostId, source);
            const response = await reader.readApplication(hostId, path('locate', { source: expected }), signal);
            signal.throwIfAborted();
            if (response.status === 404) return null;
            if (response.status !== 200) throw new Error('The original Runner did not locate this source.');
            const found = z.strictObject({ source: appSourceRouteSchema }).parse(json(response.body)).source;
            if (found.kind !== expected.kind || found.hostId !== expected.hostId || found.sessionId !== expected.sessionId) throw new Error('The Runner returned another original source.');
            return appSourceRouteSchema.parse({ ...found, hostId, kind: found.kind === 'local-dsh' ? 'federated-dsh' : found.kind });
        },
        async requestState(hostId, raw, signal) {
            const target = appNotificationTargetSchema.parse(raw);
            if (target.kind !== 'request') throw new Error('An exact original request target is required.');
            const response = await read(hostId, path('request', { target: { ...target, source: wireSource(hostId, target.source) } }), signal);
            if (response.status !== 200) throw new Error('The original Runner did not resolve this request.');
            return stateSchema.parse(json(response.body)).state;
        },
    };
}
