/** Standards-compatible, bounded SSE decoder. It retains source event IDs for resumption. */
export interface ServerEvent { data: string; id?: string; event?: string; retry?: number }

export async function* readServerEvents(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    maxEventBytes = 8 * 1024 * 1024,
): AsyncGenerator<ServerEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];
    let id: string | undefined;
    let event: string | undefined;
    let retry: number | undefined;
    let bytes = 0;
    let first = true;
    let skipLf = false;
    const abort = (): void => { void reader.cancel(signal.reason).catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    try {
        while (!signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            let text = decoder.decode(chunk.value, { stream: true });
            if (first && text.length) {
                first = false;
                if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
            }
            for (const char of text) {
                if (skipLf) {
                    skipLf = false;
                    if (char === '\n') continue;
                }
                if (char !== '\n' && char !== '\r') {
                    buffer += char;
                    bytes += char.length * 2;
                    if (bytes > maxEventBytes) throw new Error('HAPI event exceeds the configured limit');
                    continue;
                }
                skipLf = char === '\r';
                const line = buffer;
                buffer = '';
                if (line === '') {
                    // ID-only records also update the reconnection cursor, even without message data.
                    if (data.length || id !== undefined || retry !== undefined) {
                        yield {
                            data: data.join('\n'),
                            ...(id === undefined ? {} : { id }),
                            ...(event === undefined ? {} : { event }),
                            ...(retry === undefined ? {} : { retry }),
                        };
                    }
                    data = [];
                    id = undefined;
                    event = undefined;
                    retry = undefined;
                    bytes = 0;
                    continue;
                }
                if (line.startsWith(':')) continue;
                const colon = line.indexOf(':');
                const field = colon === -1 ? line : line.slice(0, colon);
                let value = colon === -1 ? '' : line.slice(colon + 1);
                if (value.startsWith(' ')) value = value.slice(1);
                if (field === 'data') data.push(value);
                else if (field === 'id' && !value.includes('\0')) id = value;
                else if (field === 'event') event = value;
                else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
            }
        }
        // Per SSE, an unterminated event at EOF is not committed.
    } finally {
        signal.removeEventListener('abort', abort);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
