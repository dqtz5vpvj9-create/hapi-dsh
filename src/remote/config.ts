import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { DirectSourceConfig } from './protocol.ts';

const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const nonempty = z.string().min(1).max(8192).refine(value => !value.includes('\0'));
const codex = z.strictObject({
    id: label, machineId: label, engine: z.literal('codex'),
    endpoint: nonempty.optional(), command: nonempty.optional(), args: z.array(z.string().max(8192).refine(value => !value.includes('\0'))).max(64).optional(),
    cwd: nonempty.optional(), codexHome: nonempty.optional(), ownership: z.enum(['shared', 'exclusive']).optional(), writerLock: z.literal('native').optional(),
    historyMetadata: z.strictObject({ command: nonempty, args: z.array(nonempty).max(64).optional() }).optional(),
});
/** Only an operator-authored private config can select executables or source endpoints. */
export function parseSources(value: unknown): DirectSourceConfig[] {
    if (Array.isArray(value) && value.some(source => source && typeof source === 'object' && source.engine === 'dsh')) throw new Error('The HAPI-owned DSH source has been retired. Recover its exact session aliases offline and pair the original DSH Host; do not create a replacement Agent.');
    const sources = z.array(codex).max(32).parse(value);
    const ids = new Set<string>();
    for (const source of sources) {
        if (ids.has(source.id)) throw new Error('Source IDs must be unique on one Host');
        ids.add(source.id);
        if (source.cwd !== undefined && !isAbsolute(source.cwd) || source.codexHome !== undefined && !isAbsolute(source.codexHome)) throw new Error('Source cwd and codexHome must be absolute');
        if (source.endpoint) {
            const url = new URL(source.endpoint);
            // Loopback native app-server only. Remote machine access is the
            // authenticated federation path, not an unauthenticated public WS.
            const localSocket = url.protocol === 'unix:' && !url.hostname && isAbsolute(source.endpoint.slice(7));
            const loopback = url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
            if ((!localSocket && !loopback) || url.username || url.password || url.search || url.hash) throw new Error('Codex endpoint must be a private Unix socket or credential-free loopback WebSocket URL');
            if (source.command || source.args || source.codexHome) throw new Error('A source uses either an existing endpoint or a local app-server command');
        }
    }
    return sources as DirectSourceConfig[];
}

/** Operator assertion that these services run in the source OS user context. */
export interface SourceWorkspaceConfig { sourceId: string; provider: 'local-system' }
export function parseSourceWorkspaces(value: unknown, sources: readonly DirectSourceConfig[]): SourceWorkspaceConfig[] {
    const entries = z.array(z.strictObject({ sourceId: label, provider: z.literal('local-system') })).max(32).parse(value);
    const ids = new Set<string>();
    for (const entry of entries) {
        if (ids.has(entry.sourceId)) throw new Error('Each source has one workspace provider');
        ids.add(entry.sourceId);
        const source = sources.find(source => source.id === entry.sourceId);
        if (!source || source.engine !== 'codex') throw new Error('Local source services require an explicitly configured Codex source');
    }
    return entries;
}
