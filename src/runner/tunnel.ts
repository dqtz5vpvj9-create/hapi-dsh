import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import { MAX_FRAME_BYTES, parseFrame, type DataLane, type FederationFrame } from './protocol.ts';

export function bytes(data: RawData): Buffer {
    return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
}

/** Per-chunk acknowledgments bound buffering independently for every live HTTP/WS channel. */
export class Tunnel {
    private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    private closed = false;
    private alive = true;
    private readonly heartbeat: ReturnType<typeof setInterval>;

    constructor(readonly socket: WebSocket, private readonly receive: (frame: FederationFrame) => Promise<void> | void, private readonly ended: () => void) {
        socket.on('message', (data, binary) => {
            if (binary) { this.close(1002); return; }
            let frame: FederationFrame;
            try { frame = parseFrame(bytes(data).toString('utf8')); }
            catch { this.close(1002); return; }
            if (frame.type === 'ack') {
                const waiter = this.pending.get(frame.ticket);
                if (waiter) { clearTimeout(waiter.timer); this.pending.delete(frame.ticket); waiter.resolve(); }
                return;
            }
            void Promise.resolve().then(() => this.receive(frame)).then(async () => {
                if (frame.type === 'data') await this.send({ type: 'ack', ticket: frame.ticket });
            }).catch(() => this.close(1011));
        });
        socket.on('pong', () => { this.alive = true; });
        socket.on('error', () => this.close(1011));
        socket.on('close', () => this.finish());
        this.heartbeat = setInterval(() => {
            if (!this.alive) { socket.terminate(); this.finish(); return; }
            this.alive = false;
            if (socket.readyState === WebSocket.OPEN) socket.ping();
        }, 15_000);
        this.heartbeat.unref();
    }

    get isOpen(): boolean { return !this.closed && this.socket.readyState === WebSocket.OPEN; }

    async send(frame: FederationFrame): Promise<void> {
        if (!this.isOpen) throw new Error('Runner connection is unavailable');
        const text = JSON.stringify(frame);
        if (Buffer.byteLength(text) > MAX_FRAME_BYTES || this.socket.bufferedAmount > MAX_FRAME_BYTES) {
            throw new Error('Runner transport buffer limit exceeded');
        }
        await new Promise<void>((resolve, reject) => this.socket.send(text, (error) => error ? reject(error) : resolve()));
    }

    async sendData(id: string, lane: DataLane, data: Buffer, binary?: boolean): Promise<void> {
        const ticket = randomUUID();
        let settle!: () => void;
        let reject!: (error: Error) => void;
        const acknowledged = new Promise<void>((resolve, fail) => { settle = resolve; reject = fail; });
        const timer = setTimeout(() => {
            this.pending.delete(ticket);
            reject(new Error('Runner transport acknowledgment timed out'));
        }, 60_000);
        timer.unref();
        this.pending.set(ticket, { resolve: settle, reject, timer });
        // Attach the rejection observer before send can yield to a physical disconnect.
        const delivery = this.send({ type: 'data', id, lane, data: data.toString('base64'), ticket, ...(binary === undefined ? {} : { binary }) });
        try { await Promise.all([delivery, acknowledged]); }
        finally { clearTimeout(timer); this.pending.delete(ticket); }
    }

    close(code = 1000): void {
        if (this.closed) return;
        if (this.socket.readyState === WebSocket.OPEN) this.socket.close(code);
        else this.socket.terminate();
        this.finish();
    }

    private finish(): void {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.heartbeat);
        for (const waiter of this.pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error('Runner disconnected; operation delivery is not retried'));
        }
        this.pending.clear();
        this.ended();
    }
}
