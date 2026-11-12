/** Bounded fallback over canonical source history, never a second index. */
import { openSync, readSync, closeSync, statSync, createReadStream } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';

/** Native .162 compression pledges the original length in its zstd frame.
 * Unknown encoders fall back to bounded decoding rather than assuming complete. */
export function rolloutLength(path) {
    if (!path.endsWith('.zst')) return statSync(path).size;
    const file = openSync(path, 'r');
    try {
        const header = Buffer.alloc(18), n = readSync(file, header, 0, header.length, 0);
        if (n < 6 || header.readUInt32LE(0) !== 0xfd2fb528) return undefined;
        const flags = header[4], single = Boolean(flags & 32), flag = flags >>> 6;
        const start = 5 + Number(!single) + [0, 1, 2, 4][flags & 3];
        const size = flag === 0 ? Number(single) : [0, 2, 4, 8][flag];
        if (!size || start + size > n) return undefined;
        const length = size === 8 ? Number(header.readBigUInt64LE(start)) : header.readUIntLE(start, size) + (size === 2 ? 256 : 0);
        return Number.isSafeInteger(length) ? length : undefined;
    } finally { closeSync(file); }
}

function textFromLine(line, cutoff) {
    const value = JSON.parse(line), p = value.payload;
    if (cutoff !== undefined) {
        if (!Number.isSafeInteger(value.ordinal)) throw new Error('Cannot prove inherited history cutoff');
        if (value.ordinal >= cutoff) return { end: true };
    }
    if (value.type === 'event_msg') {
        if (p?.type === 'user_message' || p?.type === 'agent_message') return { text: p.message };
        if (p?.type === 'item_completed') {
            const item = p.item;
            if (['agentMessage', 'agent_message'].includes(item?.type)) return { text: item.text };
            if (['userMessage', 'user_message'].includes(item?.type)) return { text: item.content?.filter(v => v.type === 'text').map(v => v.text).join(' ') };
        }
    }
    if (value.type === 'response_item' && p?.type === 'message' && ['user', 'assistant'].includes(p.role))
        return { text: p.content?.filter(v => ['input_text', 'output_text'].includes(v.type)).map(v => v.text).join(' ') };
    return {};
}

/** A cursor retains only a bounded partial line and source stream, not bodies.
 * Skipped decompression bytes count toward each batch, including old zstd tails. */
export class RolloutSearch {
    constructor(path, start, end, cutoff, maxLineBytes) {
        this.path = path; this.start = start; this.end = end; this.cutoff = cutoff;
        this.maxLineBytes = maxLineBytes; this.offset = 0; this.buffer = Buffer.alloc(0);
        this.file = statSync(path); this.done = end !== undefined && start === end;
    }
    close() { this.input?.destroy(); this.output?.destroy(); this.done = true; }
    async read(budget, signal, match) {
        const file = statSync(this.path, { throwIfNoEntry: false });
        if (!file || file.dev !== this.file.dev || file.ino !== this.file.ino || file.size < this.file.size)
            throw Object.assign(new Error('Canonical history replaced'), { code: 'STALE_VERSION' });
        let bytes = 0, items = 0;
        const abort = () => this.close();
        signal.addEventListener('abort', abort, { once: true });
        try {
            while (!this.done && items < budget.items && bytes < budget.bytes && (items + bytes === 0 || performance.now() < budget.deadline)) {
                signal.throwIfAborted();
                const newline = this.buffer.indexOf(10);
                if (newline > this.maxLineBytes) throw new Error('Canonical message exceeds search page budget');
                if (newline >= 0) {
                    const line = this.buffer.subarray(0, newline).toString('utf8');
                    this.buffer = this.buffer.subarray(newline + 1); ++items;
                    if (line.trim()) {
                        const parsed = textFromLine(line, this.cutoff);
                        if (parsed.end) { this.close(); break; }
                        if (typeof parsed.text === 'string') {
                            const snippet = match(parsed.text);
                            if (snippet !== undefined) { this.close(); return { bytes, items, snippet }; }
                        }
                    }
                    continue;
                }
                if (this.buffer.length > this.maxLineBytes) throw new Error('Canonical message exceeds search page budget');
                if (!this.iterator) {
                    const compressed = this.path.endsWith('.zst');
                    this.offset = compressed ? 0 : this.start;
                    const chunkSize = Math.max(64, Math.min(16 * 1024, this.maxLineBytes));
                    this.input = createReadStream(this.path, { highWaterMark: chunkSize,
                        ...(compressed ? { end: this.file.size - 1 } : { start: this.start, ...(this.end === undefined ? {} : { end: this.end - 1 }) }) });
                    this.output = compressed ? this.input.pipe(createZstdDecompress({ chunkSize })) : this.input;
                    if (compressed) this.input.on('error', error => this.output.destroy(error));
                    this.iterator = this.output[Symbol.asyncIterator]();
                }
                if (this.end !== undefined && this.offset >= this.end) {
                    // A partial durable final line is unknown, never a false
                    // complete/no-match; a later explicit query may include it.
                    if (this.buffer.length) throw new Error('Canonical history ends in an incomplete record');
                    this.close(); break;
                }
                const chunk = await this.iterator.next(); signal.throwIfAborted();
                if (chunk.done) {
                    if (this.buffer.length) throw new Error('Canonical history ends in an incomplete record');
                    this.close(); break;
                }
                const raw = Buffer.from(chunk.value), from = Math.max(0, this.start - this.offset);
                const to = this.end === undefined ? raw.length : Math.min(raw.length, this.end - this.offset);
                this.offset += raw.length; bytes += raw.length;
                if (to > from) this.buffer = Buffer.concat([this.buffer, raw.subarray(from, to)]);
            }
            return { bytes, items };
        } finally { signal.removeEventListener('abort', abort); }
    }
}
