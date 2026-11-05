/** Source-wide sparse-history channel. Only metadata queries cross this pipe. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { readNativeMetadata, type NativeMetadataPage, type NativeMetadataRequest } from './codex-metadata-core.mjs';
import { SourceError, waitFor } from './errors.ts';
import type { DirectCodexConfig } from './protocol.ts';

const ordinal = z.number().int().nonnegative().max(Math.floor((Number.MAX_SAFE_INTEGER - 7) / 8));
const nullableTime = z.number().finite().nullable();
const metadataPage = z.object({
    items: z.array(z.object({ turnId: z.string(), itemId: z.string(), ordinal, startedAtMs: nullableTime,
        completedAtMs: nullableTime, revision: z.number().int().nonnegative(), predecessorId: z.string().nullable() })),
    turns: z.array(z.object({ id: z.string(), status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']),
        startedAt: nullableTime, completedAt: nullableTime, ordinal, endOrdinal: ordinal.nullable(), error: z.unknown().optional() })),
    hasBefore: z.boolean(), hasAfter: z.boolean(), coordinates: z.string(), first: ordinal.nullable().optional(), last: ordinal.nullable().optional(),
});
const unavailable = (timeout = false): SourceError => new SourceError('HISTORY_UNAVAILABLE', timeout
    ? 'The native history metadata helper did not respond within its operation deadline. Existing accepted history remains available.'
    : 'The native sparse history index is unavailable. Configure a source-side historyMetadata helper for remote Codex homes.');
interface Pending { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }
interface Channel { child: ChildProcessWithoutNullStreams; closed: Promise<void>; pending: Map<number, Pending>; closing: boolean }

/** One configured helper/SSH process per source, independent of all Panes. */
export class NativeMetadataReader {
    private channel: Channel | undefined;
    private readonly channels = new Set<Channel>();
    private nextId = 0;
    private disposed = false;
    private disposing: Promise<void> | undefined;
    constructor(private readonly config: DirectCodexConfig, private readonly timeoutMs = 30_000) {}
    /** Start the read-only source channel during adapter/catalog setup. */
    warm(): void { if (this.config.historyMetadata && !this.disposed) this.connect(); }
    private connect(): Channel {
        if (this.disposed) throw new SourceError('DISPOSED', 'The native metadata source was closed.');
        if (this.channel) return this.channel;
        const helper = this.config.historyMetadata!;
        const args = helper.args ?? [];
        const child = spawn(helper.command, args.includes('--serve') ? args : [...args, '--serve'],
            { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const channel: Channel = { child, pending: new Map(), closing: false,
            closed: new Promise(resolve => { child.once('close', () => { resolve(); }); }) };
        this.channel = channel; this.channels.add(channel);
        void channel.closed.then(() => { this.channels.delete(channel); });
        const lost = (): void => {
            if (channel.closing) return;
            channel.closing = true;
            if (this.channel === channel) this.channel = undefined;
            for (const pending of channel.pending.values()) { pending.cleanup(); pending.reject(unavailable()); }
            channel.pending.clear();
        };
        const decoder = new StringDecoder('utf8'); let buffer = '';
        child.stderr.resume();
        child.once('error', lost); child.once('close', lost); child.stdin.on('error', lost);
        child.stdout.on('data', (chunk: Buffer) => {
            buffer += decoder.write(chunk);
            if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { lost(); child.kill(); return; }
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
                try {
                    const message = JSON.parse(line) as { id: number; result?: unknown; error?: string };
                    const pending = channel.pending.get(message.id);
                    if (!pending) continue; // An explicitly cancelled read may finish later.
                    channel.pending.delete(message.id); pending.cleanup();
                    if (message.error) pending.reject(unavailable()); else pending.resolve(message.result);
                } catch { lost(); child.kill(); return; }
            }
        });
        return channel;
    }
    async read(request: NativeMetadataRequest, signal: AbortSignal): Promise<NativeMetadataPage> {
        signal.throwIfAborted();
        if (this.disposed) throw new SourceError('DISPOSED', 'The native metadata source was closed.');
        try {
            let page: unknown;
            if (!this.config.historyMetadata) page = await waitFor(readNativeMetadata(request), signal);
            else {
                const channel = this.connect(), id = ++this.nextId;
                if (channel.pending.size >= 128) throw unavailable();
                page = await new Promise<unknown>((resolve, reject) => {
                    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
                    const finish = (error: unknown): void => {
                        const pending = channel.pending.get(id);
                        if (!pending) return;
                        channel.pending.delete(id); cleanup(); reject(error);
                    };
                    // Cancellation owns just this request, never another Pane's
                    // source connection. The helper performs read-only queries.
                    const abort = (): void => { finish(signal.reason); };
                    const timer = setTimeout(() => {
                        // An operationally hung read can stall its source process.
                        // Retire that read-only channel; the next request opens a
                        // fresh helper. Explicit caller cancellation stays local.
                        if (channel.closing) return;
                        channel.closing = true;
                        if (this.channel === channel) this.channel = undefined;
                        for (const active of channel.pending.values()) { active.cleanup(); active.reject(unavailable(true)); }
                        channel.pending.clear(); channel.child.kill();
                    }, this.timeoutMs);
                    channel.pending.set(id, { resolve, reject, cleanup });
                    signal.addEventListener('abort', abort, { once: true });
                    channel.child.stdin.write(JSON.stringify({ id, request }) + '\n', error => { if (error) finish(unavailable()); });
                    if (signal.aborted) abort();
                });
            }
            signal.throwIfAborted();
            return metadataPage.parse(page);
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof SourceError) throw error;
            throw unavailable();
        }
    }
    dispose(): Promise<void> {
        if (this.disposing) return this.disposing;
        this.disposed = true;
        this.channel = undefined;
        const channels = [...this.channels];
        for (const channel of channels) {
            if (channel.closing) continue;
            channel.closing = true;
            for (const pending of channel.pending.values()) { pending.cleanup(); pending.reject(new SourceError('DISPOSED', 'The native metadata source was closed.')); }
            channel.pending.clear(); channel.child.kill();
        }
        return this.disposing = Promise.all(channels.map(channel => channel.closed)).then(() => {});
    }
}

/** One-shot API for isolated probes; production adapters retain a reader. */
export async function nativeMetadata(config: DirectCodexConfig, request: NativeMetadataRequest, signal: AbortSignal): Promise<NativeMetadataPage> {
    const reader = new NativeMetadataReader(config);
    try { return await reader.read(request, signal); } finally { await reader.dispose(); }
}
