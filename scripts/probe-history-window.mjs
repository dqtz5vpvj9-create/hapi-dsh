/** Read-only protocol probe. No browser, source mutations, or product window changes.
 * A single official follow opening supplies the inclusive cut for every page.
 * Only aggregate numbers leave memory; credentials, identities and text do not.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote';
import { parseRemoteStreamServerMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol';

const WINDOWS = [20, 4, 2];
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const milliseconds = value => Math.round(value * 100) / 100;
const fail = () => { throw new Error('Probe failed'); };

export function options(env) {
    const sessionId = env.HAPI_DSH_PROBE_SESSION_ID;
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId !== sessionId.trim()) fail();
    const timeoutMs = Number(env.HAPI_DSH_PROBE_TIMEOUT_MS ?? 60_000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) fail();
    const launchFile = env.HAPI_DSH_LAUNCH_FILE ?? join(homedir(), '.config/hapi-dsh/launch-url');
    const outputFile = env.HAPI_DSH_PROBE_OUTPUT ?? `/mnt/cache/data-cache/hapi-history-window-${Date.now()}.json`;
    if (!launchFile.trim() || !outputFile.trim() || launchFile === outputFile) fail();
    return { sessionId, timeoutMs, launchFile, outputFile };
}

/** Fixed buckets deliberately exclude arbitrary plugin names and payload fields. */
export function recordSizes(records) {
    const groups = Object.fromEntries(['body', 'plugin', 'tool', 'step', 'turn', 'other']
        .map(name => [name, { count: 0, bytes: 0 }]));
    let appendMessages = 0;
    let turnStarts = 0;
    for (const record of records) {
        const type = record.event.type;
        const body = type === 'user/message' || type === 'assistant/message';
        const group = body ? 'body' : type.startsWith('plugin:') ? 'plugin'
            : ['tool', 'step', 'turn'].find(name => type.startsWith(`${name}/`)) ?? 'other';
        groups[group].count++;
        groups[group].bytes += bytes(record);
        if (body && record.event.surfaceOp === 'append') appendMessages++;
        if (type === 'turn/start') turnStarts++;
    }
    return { recordCount: records.length, recordsBytes: bytes(records), appendMessages, turnStarts, groups };
}

export function pageRequest(address, throughSeq, beforeSeq, maxMessages, minMessages = maxMessages) {
    if (!Number.isSafeInteger(throughSeq) || throughSeq < -1
        || !Number.isSafeInteger(beforeSeq) || beforeSeq < 0 || beforeSeq > throughSeq + 1
        || !Number.isSafeInteger(maxMessages) || maxMessages <= 0
        || !Number.isSafeInteger(minMessages) || minMessages <= 0 || minMessages > maxMessages) fail();
    return sessionRemote.methods['session/page'].input({ strict: true }).create().parse({ request: {
        address, throughSeq, beforeSeq, maxMessages, turnWindow: { minMessages, minTurns: 2 },
    } });
}

function validateRecords(records, throughSeq, beforeSeq) {
    let previous;
    for (const { event } of records) {
        if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq > throughSeq
            || event.seq >= beforeSeq || previous !== undefined && event.seq !== previous + 1) fail();
        previous = event.seq;
    }
}

async function opening(origin, headers, address, timeoutMs) {
    const descriptor = sessionRemote.methods['session/follow'];
    const args = descriptor.input({ strict: true }).create().parse({ request: {
        address, maxMessages: 20, turnWindow: { minMessages: 20, minTurns: 2 }, assistantStream: true,
    } });
    // This is the repository's lossless carrier for the official Gateway mux.
    const url = new URL('/hapi-dsh/remote.mux', origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const started = performance.now();
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { headers: { ...headers, origin }, handshakeTimeout: timeoutMs });
        let finished = false;
        const timer = setTimeout(() => finish(), timeoutMs);
        const finish = result => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'cancel', streamId: 'history-measurement' }));
                socket.close();
                const closeTimer = setTimeout(() => socket.terminate(), 1000);
                closeTimer.unref();
                socket.once('close', () => clearTimeout(closeTimer));
            } else socket.terminate();
            if (result) resolve(result); else reject(new Error('Opening failed'));
        };
        socket.once('open', () => socket.send(JSON.stringify({ type: 'open', streamId: 'history-measurement',
            endpoint: 'session/follow', payload: { args } })));
        socket.on('error', () => finish());
        socket.once('close', () => finish());
        socket.on('message', raw => {
            if (finished) return;
            try {
                const received = performance.now();
                const text = raw.toString();
                const parsedAt = performance.now();
                const envelope = parseRemoteStreamServerMessage(text);
                const validatedAt = performance.now();
                if (envelope.streamId !== 'history-measurement' || envelope.type !== 'item') fail();
                const snapshot = envelope.value;
                descriptor.result.create().parse(snapshot);
                const validationDone = performance.now();
                if (snapshot.type !== 'snapshot' || !Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < -1) fail();
                validateRecords(snapshot.records, snapshot.cursor, snapshot.cursor + 1);
                finish({ snapshot, stats: { transport: 'websocket', elapsedMs: milliseconds(received - started),
                    decodedEnvelopeBytes: Buffer.byteLength(text), payloadBytes: bytes(snapshot),
                    parseEnvelopeMs: milliseconds(validatedAt - parsedAt), schemaValidationMs: milliseconds(validationDone - validatedAt),
                    compressionNegotiated: socket.extensions.includes('permessage-deflate'),
                    projectionsBytes: bytes(snapshot.projections), assistantStreamBytes: bytes(snapshot.assistantStream ?? null),
                    hasMore: snapshot.hasMore, ...recordSizes(snapshot.records) } });
            } catch { finish(); }
        });
    });
}

async function page(origin, headers, args, timeoutMs) {
    const started = performance.now();
    const response = await fetch(new URL('/api/session/page', origin), { method: 'POST', redirect: 'error',
        headers: { ...headers, 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ type: 'client-request', rpcId: 'history-measurement', method: 'session/page', payload: { args } }),
    });
    const headersAt = performance.now();
    if (!response.ok) fail();
    const buffer = Buffer.from(await response.arrayBuffer());
    const received = performance.now();
    const envelope = JSON.parse(buffer.toString('utf8'));
    const parsedAt = performance.now();
    if (envelope.result?.ok !== true) fail();
    const value = envelope.result.value;
    sessionRemote.methods['session/page'].result.create().parse(value);
    const validatedAt = performance.now();
    validateRecords(value.records, args.request.throughSeq, args.request.beforeSeq);
    const length = response.headers.get('content-length');
    return { value, stats: { transport: 'http', elapsedMs: milliseconds(received - started),
        headersMs: milliseconds(headersAt - started), bodyReadMs: milliseconds(received - headersAt),
        jsonParseMs: milliseconds(parsedAt - received), schemaValidationMs: milliseconds(validatedAt - parsedAt),
        decodedEnvelopeBytes: buffer.byteLength, payloadBytes: bytes(value),
        ...(length !== null && /^\d+$/.test(length) ? { contentLengthBytes: Number(length) } : {}),
        // No arbitrary header strings are persisted.
        contentEncoding: ['gzip', 'br', 'deflate'].includes(response.headers.get('content-encoding'))
            ? response.headers.get('content-encoding') : 'identity-or-other',
        hasMore: value.hasMore, ...recordSizes(value.records) } };
}

async function main() {
    const report = { version: 1, mode: 'fixed-cut-read-only', complete: false, windows: [] };
    let config;
    let stage = 'parameters';
    try {
        config = options(process.env);
        stage = 'admission';
        const launch = new URL((await readFile(config.launchFile, 'utf8')).trim());
        if (!['https:', 'http:'].includes(launch.protocol) || launch.username || launch.password) fail();
        const admission = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(config.timeoutMs) });
        if (admission.status !== 303) fail();
        const cookie = admission.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
        if (!cookie) fail();
        await admission.body?.cancel();
        const headers = { cookie };
        const address = { kind: 'session', sessionId: config.sessionId };
        stage = 'follow-opening';
        const baseline = await opening(launch.origin, headers, address, config.timeoutMs);
        report.opening = baseline.stats;
        // Never persist this cut or any identity; all page requests use the same cut.
        const throughSeq = baseline.snapshot.cursor;
        const beforeSeq = throughSeq + 1;
        const windows = [];
        for (const maxMessages of WINDOWS) {
            stage = `window-${maxMessages}`;
            const result = await page(launch.origin, headers,
                pageRequest(address, throughSeq, beforeSeq, maxMessages), config.timeoutMs);
            windows.push({ maxMessages, result });
            report.windows.push({ maxMessages, opening: result.stats });
        }
        // One unconditional older-page measurement per candidate quantifies the
        // 500/50/2 loadOlder cost. It is NOT a claim that automatic fill runs:
        // current/previous-turn completion, reader gestures and 1500 records can stop it.
        for (const { maxMessages, result } of windows) {
            const row = report.windows.find(value => value.maxMessages === maxMessages);
            const first = result.value.records[0]?.event.seq;
            if (!result.value.hasMore || first === undefined) { row.older500Skipped = true; continue; }
            stage = `older-${maxMessages}`;
            const older = await page(launch.origin, headers,
                pageRequest(address, throughSeq, first, 500, 50), config.timeoutMs);
            if (older.value.records.length && older.value.records.at(-1).event.seq !== first - 1) fail();
            row.older500 = older.stats;
            row.afterOneOlder500 = recordSizes([...older.value.records, ...result.value.records]);
        }
        report.complete = true;
    } catch {
        // Remote errors and validation errors can contain private payloads.
        report.failureStage = stage;
        process.exitCode = 1;
    }
    report.notes = [
        'Windows use one follow cursor and the same exclusive latest beforeSeq; later writes are excluded.',
        'Body counts user/message and assistant/message; appendMessages matches the public pager budget.',
        'Byte counts are decoded JSON, not compressed WebSocket bytes. HTTP contentLength is reported only when supplied.',
        'HTTP timings include Host cache/I/O and network; Node parse/schema timings are not browser layout or cold navigation timings.',
        'Requests are serial; the follow opening may warm Host history. Window order is 20,4,2; older500 reads follow afterward.',
        'Older500 is one counterfactual page per window, not a change to auto-fill, current/previous-turn, deep-link or approval behavior.',
    ];
    if (config) {
        try { await writeFile(config.outputFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }
        catch { report.complete = false; report.failureStage = 'report-write'; process.exitCode = 1; }
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (process.argv.length === 3 && process.argv[2] === '--run') await main();
    else if (process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--help') {
        process.stdout.write('Read-only history window probe. Run explicitly with --run.\n'
            + 'Required: HAPI_DSH_PROBE_SESSION_ID (existing display session; never printed).\n'
            + 'Optional: HAPI_DSH_LAUNCH_FILE, HAPI_DSH_PROBE_OUTPUT, HAPI_DSH_PROBE_TIMEOUT_MS (1..300000).\n'
            + 'Uses one official follow opening, then same-cut HTTP pages of 20/4/2 and one older500 page per candidate.\n'
            + 'No source mutations; follow may perform the same official activation as opening an existing session.\n');
    } else { process.stderr.write('Invalid arguments. Use --help or --run.\n'); process.exitCode = 1; }
}
