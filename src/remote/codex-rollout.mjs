import { existsSync, createReadStream } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';

/** Codex keeps the logical .jsonl path in SQLite after transparent compression. */
export function resolveRolloutPath(path) {
    if (existsSync(path)) return path;
    const alternate = path.endsWith('.zst') ? path.slice(0, -4) : `${path}.zst`;
    return existsSync(alternate) ? alternate : undefined;
}

/** Stop decompression at the first line; never inflate a transcript to read its header. */
export async function readRolloutHeader(path, { signal, maxBytes = Infinity } = {}) {
    signal?.throwIfAborted();
    const actual = resolveRolloutPath(path) ?? path;
    const input = createReadStream(actual, { highWaterMark: 4096 });
    const output = actual.endsWith('.zst') ? input.pipe(createZstdDecompress()) : input;
    const onError = (error) => output.destroy(error);
    if (output !== input) input.on('error', onError);
    const chunks = []; let size = 0;
    try {
        for await (const chunk of output) {
            signal?.throwIfAborted();
            const bytes = Buffer.from(chunk);
            const newline = bytes.indexOf(10);
            const part = newline < 0 ? bytes : bytes.subarray(0, newline);
            size += part.length;
            if (size > maxBytes) throw new Error('Native session header exceeds its metadata budget');
            chunks.push(part);
            if (newline >= 0) break;
        }
        return Buffer.concat(chunks).toString('utf8');
    } finally {
        output.destroy();
        input.destroy();
    }
}
