/** Source-side sparse metadata helper; Node24 builtins only, no execution operations. */
import { readNativeMetadata, readNativeLifecycles, readNativeQuestions, NativeMetadataIndexMissing } from './codex-metadata-core.mjs';
import { NativeHistorySearch, NativeSearchError } from './codex-search-core.mjs';
import { createInterface } from 'node:readline';

const failure = error => ({ error: error instanceof Error ? error.message : 'Native history metadata unavailable',
    ...(error instanceof NativeSearchError ? { searchCode: error.code } : {}),
    ...(error instanceof NativeMetadataIndexMissing ? { errorKind: 'missing-index' } : {}) });

if (process.argv.includes('--serve')) {
    // One source connection serves all its readers. IDs bind each response to
    // its caller; closing one Pane never tears down this shared read channel.
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const searches = new NativeHistorySearch(), active = new Map(), work = new Set();
    for await (const line of lines) {
        let id;
        try {
            if (Buffer.byteLength(line) > 64 * 1024) throw new Error('Metadata request exceeds its input budget');
            const message = JSON.parse(line); id = message.id;
            if (Number.isSafeInteger(message.cancel) && message.cancel > 0) { active.get(message.cancel)?.abort(); continue; }
            if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid metadata request identity');
            if (active.has(id) || active.size >= 128) throw new Error('Metadata request capacity exceeded');
            const controller = new AbortController(); active.set(id, controller);
            const task = Promise.resolve().then(() => message.request.kind === 'search'
                ? searches.search(message.request, controller.signal) : message.request.kind === 'lifecycle'
                    ? readNativeLifecycles(message.request) : message.request.kind === 'questions'
                        ? readNativeQuestions(message.request) : readNativeMetadata(message.request))
                .then(result => { if (!controller.signal.aborted) process.stdout.write(JSON.stringify({ id, result }) + '\n'); },
                    error => { if (!controller.signal.aborted) process.stdout.write(JSON.stringify({ id, ...failure(error) }) + '\n'); })
                .finally(() => { active.delete(id); work.delete(task); });
            work.add(task);
        } catch (error) { process.stdout.write(JSON.stringify({ id, ...failure(error) }) + '\n'); }
    }
    for (const controller of active.values()) controller.abort();
    await Promise.allSettled(work); searches.dispose();
} else {
    // Preserve the bounded EOF request format used by operator probes.
    let input = '';
    try {
        for await (const chunk of process.stdin) {
            input += chunk;
            if (Buffer.byteLength(input) > 64 * 1024) throw new Error('Metadata request exceeds its input budget');
        }
        const request = JSON.parse(input);
        process.stdout.write(JSON.stringify({ result: request.kind === 'lifecycle' ? readNativeLifecycles(request)
            : request.kind === 'questions' ? await readNativeQuestions(request) : await readNativeMetadata(request) }) + '\n');
    } catch (error) {
        process.stdout.write(JSON.stringify(failure(error)) + '\n');
        process.exitCode = 1;
    }
}
