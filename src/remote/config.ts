import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { DirectCodexConfig } from './protocol.ts';

const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const nonempty = z.string().min(1).max(8192).refine(value => !value.includes('\0'));
const schema = z.strictObject({
    id: label, machineId: label, engine: z.literal('codex'),
    endpoint: nonempty.optional(), command: nonempty.optional(), args: z.array(z.string().max(8192).refine(value => !value.includes('\0'))).max(64).optional(),
    cwd: nonempty.optional(), codexHome: nonempty.optional(), ownership: z.enum(['shared', 'exclusive']).optional(),
});
/** Only an operator-authored private config can select executables or source endpoints. */
export function parseSources(value: unknown): DirectCodexConfig[] {
    const sources = z.array(schema).max(32).parse(value);
    const ids = new Set<string>();
    for (const source of sources) {
        if (ids.has(source.id)) throw new Error('Source IDs must be unique on one Host');
        ids.add(source.id);
        if (source.cwd !== undefined && !isAbsolute(source.cwd) || source.codexHome !== undefined && !isAbsolute(source.codexHome)) throw new Error('Source cwd and codexHome must be absolute');
        if (source.endpoint) {
            const url = new URL(source.endpoint);
            // Loopback native app-server only. Remote machine access is the
            // authenticated federation path, not an unauthenticated public WS.
            if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Codex endpoint must be a credential-free loopback WebSocket URL');
            if (source.command || source.args || source.codexHome) throw new Error('A source uses either an existing endpoint or a local app-server command');
        }
    }
    return sources as DirectCodexConfig[];
}
