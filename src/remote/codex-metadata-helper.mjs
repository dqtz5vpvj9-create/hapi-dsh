/** Source-side sparse metadata helper; Node24 builtins only, no execution operations. */
import { readNativeMetadata } from './codex-metadata-core.mjs';
import { createInterface } from 'node:readline';

if (process.argv.includes('--serve')) {
    // One source connection serves all its readers. IDs bind each response to
    // its caller; closing one Pane never tears down this shared read channel.
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
        let id;
        try {
            if (Buffer.byteLength(line) > 64 * 1024) throw new Error('Metadata request exceeds its input budget');
            const message = JSON.parse(line); id = message.id;
            if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid metadata request identity');
            process.stdout.write(JSON.stringify({ id, result: await readNativeMetadata(message.request) }) + '\n');
        } catch (error) { process.stdout.write(JSON.stringify({ id, error: error instanceof Error ? error.message : 'Native history metadata unavailable' }) + '\n'); }
    }
} else {
    // Preserve the bounded EOF request format used by operator probes.
    let input = '';
    try {
        for await (const chunk of process.stdin) {
            input += chunk;
            if (Buffer.byteLength(input) > 64 * 1024) throw new Error('Metadata request exceeds its input budget');
        }
        process.stdout.write(JSON.stringify({ result: await readNativeMetadata(JSON.parse(input)) }) + '\n');
    } catch (error) {
        process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : 'Native history metadata unavailable' }) + '\n');
        process.exitCode = 1;
    }
}
