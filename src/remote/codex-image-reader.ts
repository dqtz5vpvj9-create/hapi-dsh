/** Native preview bytes use disposable connections, never the thread/approval transport. */
import { isAbsolute, win32 } from 'node:path';
import { CodexRpc } from './codex-rpc.ts';
import { isRecord } from './codex-native.ts';
import { SourceError } from './errors.ts';
import type { DirectCodexConfig } from './protocol.ts';

export const MAX_NATIVE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_NATIVE_IMAGE_BYTES / 3) * 4;
const MAX_READS = 2;
const MAX_WAITING = 32;
interface WaitingRead { start(): void; cancel(): void }

/**
 * Only CodexAttachments may supply paths already admitted from native history.
 * The pinned fs/getMetadata API has no byte count and fs/readFile has no range
 * or size limit. Its preflight can reject non-files, but cannot bound a response
 * or eliminate a replacement race. Every read therefore owns its own CodexRpc:
 * even a file that grows beyond the unchanged RPC frame limit can fail only its
 * preview. These connections never subscribe to, resume or execute a thread.
 */
export class CodexImageReader {
    private readonly lifetime = new AbortController();
    private readonly active = new Set<CodexRpc>();
    private readonly waiting = new Set<WaitingRead>();
    private slots = 0;
    private disposing: Promise<void> | undefined;

    constructor(private readonly config: DirectCodexConfig, private readonly timeoutMs = 30_000) {}

    async read(path: string, signal?: AbortSignal): Promise<{ dataBase64: string }> {
        const scope = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal;
        scope.throwIfAborted();
        if (!(isAbsolute(path) || win32.isAbsolute(path)) || path.includes('\0')) {
            throw new SourceError('INVALID_REQUEST', 'The native image has no valid source path.');
        }
        await this.acquire(scope);
        let rpc: CodexRpc | undefined;
        let image: { dataBase64: string };
        try {
            scope.throwIfAborted();
            rpc = new CodexRpc(this.config, this.timeoutMs);
            // Some non-thread requests are broadcast. This viewer must neither
            // answer them nor let CodexRpc send its default unsupported reply.
            rpc.onRequest(() => {});
            this.active.add(rpc);
            const meta = await rpc.request<unknown>('fs/getMetadata', { path }, { signal: scope });
            if (!isRecord(meta) || meta.isFile !== true || meta.isDirectory !== false) {
                throw new SourceError('INVALID_REQUEST', 'The native image does not resolve to a regular file.');
            }
            const result = await rpc.request<unknown>('fs/readFile', { path }, { signal: scope });
            if (!isRecord(result) || typeof result.dataBase64 !== 'string') {
                throw new SourceError('INVALID_REQUEST', 'The source returned an invalid image response.');
            }
            if (result.dataBase64.length === 0 || result.dataBase64.length > MAX_BASE64_LENGTH
                || Buffer.byteLength(result.dataBase64, 'base64') > MAX_NATIVE_IMAGE_BYTES) {
                throw new SourceError('CAPACITY_EXCEEDED', 'The image exceeds the native preview budget.');
            }
            image = { dataBase64: result.dataBase64 };
        } finally {
            if (rpc) { await rpc.dispose(); this.active.delete(rpc); }
            this.slots--;
            this.drain();
        }
        scope.throwIfAborted();
        return image;
    }

    private acquire(signal: AbortSignal): Promise<void> {
        if (this.waiting.size >= MAX_WAITING) return Promise.reject(new SourceError('CAPACITY_EXCEEDED', 'Native image previews are busy.'));
        return new Promise((resolve, reject) => {
            const cleanup = (): void => { this.waiting.delete(waiter); signal.removeEventListener('abort', waiter.cancel); };
            const waiter: WaitingRead = {
                start: () => { cleanup(); this.slots++; resolve(); },
                cancel: () => { cleanup(); reject(signal.reason); },
            };
            this.waiting.add(waiter);
            signal.addEventListener('abort', waiter.cancel, { once: true });
            if (signal.aborted) waiter.cancel(); else this.drain();
        });
    }
    private drain(): void {
        while (!this.lifetime.signal.aborted && this.slots < MAX_READS && this.waiting.size) this.waiting.values().next().value!.start();
    }

    /** Source retirement cancels only attachment work; the caller owns its native execution RPC. */
    dispose(): Promise<void> {
        if (this.disposing) return this.disposing;
        this.lifetime.abort(new SourceError('DISPOSED', 'The native image reader is closed.'));
        this.disposing = Promise.all([...this.active].map(rpc => rpc.dispose())).then(() => {});
        return this.disposing;
    }
}
