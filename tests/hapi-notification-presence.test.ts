import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HapiClient } from '../src/hapi/client.ts';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function until(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 1500;
    while (!check()) { if (Date.now() > deadline) throw new Error('Presence fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function environment() {
    const queries: string[] = [], writes: Array<{ subscriptionId: string; visibility: string }> = [], readers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    let count = 0, holdVisible: (() => void) | undefined, resolveVisible: (() => void) | undefined, failHide = false;
    const client = new HapiClient({ hubId: 'presence-hub', url: 'http://presence.fixture', token: 'fixture-access', reconnectMinMs: 2, reconnectMaxMs: 5,
        fetch: async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/api/auth') return json({ token: 'fixture-token' });
            if (url.pathname === '/api/visibility') {
                const request = JSON.parse(String(init?.body)) as { subscriptionId: string; visibility: string }; writes.push(request);
                if (request.visibility === 'visible' && holdVisible) { holdVisible(); await new Promise<void>(resolve => { resolveVisible = resolve; }); }
                if (request.visibility === 'hidden' && failHide) { failHide = false; throw new TypeError('Original Hub hide reply was lost'); }
                return json({ ok: true });
            }
            assert.equal(url.pathname, '/api/events'); queries.push(url.searchParams.get('visibility')!); const id = `source-subscription-${++count}`;
            return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                readers.set(id, controller); controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'connection-changed', data: { status: 'connected', subscriptionId: id, resume: 'ok' } })}\n\n`));
                init?.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
            } }), { headers: { 'Content-Type': 'text/event-stream' } });
        } });
    return { client, queries, writes, readers, hold: (callback: () => void) => { holdVisible = callback; }, release: () => { holdVisible = undefined; resolveVisible?.(); }, failHide: () => { failHide = true; } };
}

test('the daemon opens its original SSE as hidden and forwards the original foreground toast unchanged', async () => {
    const fixture = environment(), events: unknown[] = [], dispose = fixture.client.subscribe(event => events.push(event));
    try {
        await until(() => fixture.client.isConnected); assert.deepEqual(fixture.queries, ['hidden']); assert.deepEqual(fixture.writes, []);
        const toast = { type: 'toast', data: { title: 'Needs input', body: 'Original source task', sessionId: 'source-one', url: '/sessions/source-one' } };
        fixture.readers.get('source-subscription-1')!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(toast)}\n\n`));
        await until(() => events.length === 2); assert.deepEqual(events[1], toast);
    } finally { dispose(); await fixture.client.close(); }
});

test('presence writes serialize a late visible acknowledgement before the latest hidden state', async () => {
    const fixture = environment(), dispose = fixture.client.subscribe(() => {});
    try {
        await until(() => fixture.client.isConnected); let admitted = false; fixture.hold(() => { admitted = true; });
        const visible = fixture.client.setVisibility('visible'); await until(() => admitted);
        const hidden = fixture.client.setVisibility('hidden'); assert.equal(fixture.writes.length, 1);
        fixture.release(); await Promise.all([visible, hidden]);
        assert.deepEqual(fixture.writes, [{ subscriptionId: 'source-subscription-1', visibility: 'visible' }, { subscriptionId: 'source-subscription-1', visibility: 'hidden' }]);
        await fixture.client.setVisibility('hidden'); assert.equal(fixture.writes.length, 2);
    } finally { fixture.release(); dispose(); await fixture.client.close(); }
});

test('an unconfirmed hide terminates the old visible SSE and reconnects hidden without replaying the POST', async () => {
    const fixture = environment(), dispose = fixture.client.subscribe(() => {});
    try {
        await until(() => fixture.client.isConnected); await fixture.client.setVisibility('visible'); fixture.failHide();
        await assert.rejects(fixture.client.setVisibility('hidden'), /HAPI|confirmation|request/i);
        await until(() => fixture.queries.length >= 2 && fixture.client.isConnected);
        assert.deepEqual(fixture.queries.slice(0, 2), ['hidden', 'hidden']); assert.equal(fixture.writes.filter(write => write.visibility === 'hidden').length, 1);
        await fixture.client.setVisibility('visible'); assert.equal(fixture.writes.at(-1)?.subscriptionId, 'source-subscription-2');
    } finally { dispose(); await fixture.client.close(); }
});

test('same-tick visibility changes cannot be swallowed by an already resolved synchronization', async () => {
    const fixture = environment(), dispose = fixture.client.subscribe(() => {});
    try {
        await until(() => fixture.client.isConnected);
        const unchanged = fixture.client.setVisibility('hidden'), visible = fixture.client.setVisibility('visible'); await Promise.all([unchanged, visible]);
        assert.equal(fixture.writes.at(-1)?.visibility, 'visible');
        const unchangedAgain = fixture.client.setVisibility('visible'), hidden = fixture.client.setVisibility('hidden'); await Promise.all([unchangedAgain, hidden]);
        assert.equal(fixture.writes.at(-1)?.visibility, 'hidden');
    } finally { dispose(); await fixture.client.close(); }
});
