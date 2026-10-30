/** Standalone Node CLI: connect stdio to an existing native WebSocket socket.
 * This process owns only its connection; it never starts or stops the daemon.
 * Bundle this entry with ws for machines without an HHPI installation.
 */
import { lstat } from 'node:fs/promises';
import { connect } from 'node:net';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';

const MAX_FRAME = 16 * 1024 * 1024;

async function main(): Promise<void> {
    const options = new Map<string, string>();
    for (let index = 2; index < process.argv.length; index += 2) {
        const name = process.argv[index], value = process.argv[index + 1];
        if ((name !== '--socket' && name !== '--path') || !value || options.has(name)) throw new Error('Expected --socket <native socket> [--path /rpc].');
        options.set(name, value);
    }
    const path = options.get('--socket'), requestPath = options.get('--path') ?? '/';
    if (!path || !requestPath.startsWith('/') || /[\r\n?#]/.test(requestPath)) throw new Error('Expected a native socket and an absolute WebSocket request path.');
    if (process.platform === 'win32') {
        if (!path.startsWith('\\\\.\\pipe\\') || path.length <= 9) throw new Error('The native endpoint must be a local Windows named pipe.');
    } else {
        if (!isAbsolute(path)) throw new Error('The native endpoint must be an absolute Unix socket path.');
        const stat = await lstat(path);
        if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('The native endpoint must be a private socket owned by this account.');
    }

    // Use the raw path so Windows pipe names cannot be normalized as URLs.
    const socket = new WebSocket(`ws://localhost${requestPath}`, {
        createConnection: () => connect(path), maxPayload: MAX_FRAME,
        followRedirects: false, handshakeTimeout: 10_000, perMessageDeflate: false,
    });
    let finishedInput = false, stopped = false;
    // A socket may fail before stdin's async iterator has installed its error listener.
    process.stdin.on('error', () => {});
    const stop = (): void => { stopped = true; process.stdin.destroy(); socket.terminate(); };
    const failed = (): void => { if (!stopped && !finishedInput) process.stdin.destroy(new Error('The native socket disconnected.')); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    process.stdout.on('error', stop);
    socket.on('error', failed);
    socket.on('close', failed);
    socket.on('message', (bytes, binary) => {
        if (stopped) return;
        try {
            if (binary) throw new Error('binary frame');
            // One WebSocket JSON message is one stdio line, including pretty-printed input.
            const line = JSON.stringify(JSON.parse(bytes.toString())) + '\n';
            if (!process.stdout.write(line)) socket.pause();
        } catch { process.stdin.destroy(new Error('The native socket returned an invalid JSON frame.')); socket.terminate(); }
    });
    const drain = (): void => { socket.resume(); };
    process.stdout.on('drain', drain);
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', () => reject(new Error('The native socket could not be opened.')));
        });
        const send = async (line: string): Promise<void> => {
            if (!line.trim()) return;
            if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('The stdio JSON frame exceeds the native frame limit.');
            JSON.parse(line);
            await new Promise<void>((resolve, reject) => socket.send(line, error => error ? reject(new Error('The native socket write failed.')) : resolve()));
        };
        const decoder = new StringDecoder('utf8');
        let buffer = '';
        for await (const chunk of process.stdin) {
            buffer += decoder.write(chunk as Buffer);
            let newline: number;
            while ((newline = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
                await send(line);
            }
            if (Buffer.byteLength(buffer) > MAX_FRAME) throw new Error('The stdio JSON frame exceeds the native frame limit.');
        }
        if (!stopped) await send(buffer + decoder.end());
        finishedInput = true;
    } finally {
        stopped = true;
        process.stdin.destroy();
        socket.terminate();
        process.off('SIGTERM', stop);
        process.off('SIGINT', stop);
        process.stdout.off('drain', drain);
    }
}

void main().catch(() => {
    // Native errors can contain paths or model content; keep diagnostics local and generic.
    process.stderr.write('HHPI native stdio bridge failed.\n');
    process.exitCode = 1;
});
