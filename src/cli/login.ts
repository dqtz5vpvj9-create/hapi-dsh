import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { resolveHapiToken, writeConfig, type RuntimeConfig } from './config.ts';

/** Keep credentials out of command arguments, terminal echo, and shell-specific setup. */
export async function readLoginToken(fromStdin: boolean): Promise<string> {
    if (fromStdin) {
        let value = '';
        for await (const chunk of process.stdin) {
            value += String(chunk);
            if (Buffer.byteLength(value) > 64 * 1024) throw new Error('HAPI access token input exceeds 64 KiB');
        }
        return value.replace(/\r?\n$/, '');
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use an interactive terminal for login, or --stdin to read a token from a pipe');
    const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const reader = createInterface({ input: process.stdin, output: silent, terminal: true });
    const cancelled = new AbortController();
    reader.on('SIGINT', () => cancelled.abort());
    reader.on('close', () => cancelled.abort());
    process.stdout.write('HAPI access token (hidden): ');
    try {
        return await reader.question('', { signal: cancelled.signal });
    } finally {
        reader.close();
        process.stdout.write('\n');
    }
}

export async function login(config: RuntimeConfig, path: string, fromStdin: boolean): Promise<void> {
    const updated = { ...config, hapi: { ...config.hapi, token: await readLoginToken(fromStdin) } };
    resolveHapiToken(updated, {});
    await writeConfig(path, updated, true);
}
