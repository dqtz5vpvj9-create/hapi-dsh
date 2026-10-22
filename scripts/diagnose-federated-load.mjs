/** Read-only production transport timings. No browser, prompt, or history text output. */
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';

const [launchFile, hostId, sessionId] = process.argv.slice(2);
if (!launchFile || !hostId || !sessionId) throw new Error('Usage: node scripts/diagnose-federated-load.mjs LAUNCH_FILE HOST_ID SESSION_ID');
const origin = new URL((await readFile(launchFile, 'utf8')).trim());
const admission = await fetch(origin, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
const headers = { cookie: admission.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ') };
const base = `/hapi-dsh/machine/${encodeURIComponent(hostId)}/`;
const remoteUrl = path => new URL(base + new URL(path, origin).pathname.replace(/^\//, '') + new URL(path, origin).search, origin);
const ms = start => Math.round(performance.now() - start);
async function read(path) {
    const start = performance.now();
    const response = await fetch(remoteUrl(path), { headers, signal: AbortSignal.timeout(30_000) });
    const body = await response.text();
    if (!response.ok) throw new Error(`Transport returned ${response.status}`);
    return { body, ms: ms(start), bytes: Buffer.byteLength(body) };
}
const bootstrap = await read('/hapi-dsh/bootstrap');
const graph = JSON.parse(bootstrap.body).graph;
console.log(JSON.stringify({ stage: 'bootstrap', ms: bootstrap.ms, bytes: bootstrap.bytes, entries: graph.entries.length }));
for (const batch of graph.batches) {
    const measured = await read(batch.url);
    console.log(JSON.stringify({ stage: `bundle.${batch.phase}`, ms: measured.ms, bytes: measured.bytes }));
}
const parallelStart = performance.now();
const parallel = await Promise.all(graph.batches.map(batch => read(batch.url)));
console.log(JSON.stringify({ stage: 'bundles.parallel', ms: ms(parallelStart), bytes: parallel.reduce((sum, row) => sum + row.bytes, 0) }));
const url = new URL('/hapi-dsh/socket', origin);
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
url.searchParams.set('machine', hostId); url.searchParams.set('path', '/api/remote.mux');
for (let trial = 0; trial < 3; trial++) {
    await new Promise((resolve, reject) => {
        const start = performance.now();
        const socket = new WebSocket(url, { headers });
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('Opening snapshot exceeded 30 s')); }, 30_000);
        let settled = false;
        const finish = error => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); error ? reject(error) : resolve(); };
        socket.on('error', () => finish(new Error('WebSocket transport failed')));
        socket.on('close', () => { if (!settled) finish(new Error('WebSocket closed before snapshot')); });
        socket.on('open', () => {
            console.log(JSON.stringify({ stage: 'socket', trial, ms: ms(start) }));
            socket.send(JSON.stringify({ type: 'open', streamId: 'load-probe', endpoint: 'session/follow', payload: { args: { request: {
                address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 500,
                turnWindow: { minMessages: 50, minTurns: 2 },
            } } } }));
        });
        socket.on('message', raw => {
            const decodeStart = performance.now(), frame = JSON.parse(raw.toString());
            if (frame.type === 'error') { finish(new Error(`Follow rejected: ${frame.error?.code ?? 'unknown'}`)); return; }
            if (frame.type !== 'item' || frame.value?.type !== 'snapshot') return;
            console.log(JSON.stringify({ stage: 'follow.snapshot', trial, ms: ms(start), parseMs: ms(decodeStart),
                bytes: raw.length, records: frame.value.records.length, hasMore: frame.value.hasMore }));
            socket.send(JSON.stringify({ type: 'cancel', streamId: 'load-probe' }));
            finish();
        });
    });
}
