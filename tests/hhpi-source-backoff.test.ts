import { nativeMetadataFixture } from './fixtures/hhpi-native-metadata.ts';
/** Real source adapter and persistent history; only the native transport and clock are controlled. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import type { CodexRpc } from '../src/remote/codex-rpc.ts';
import { SourceError } from '../src/remote/errors.ts';
import type { NativeThread } from '../src/remote/codex-native.ts';

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('thread readers share bounded source reconnect backoff while cached history stays readable', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const directory = await mkdtemp(join('/mnt/cache/data-cache', 'hhpi-source-backoff-'));
    let now = 10_000, online = true, available = true, attempts = 0, disconnected = (): void => {};
    const threads: NativeThread[] = ['one', 'two'].map(id => ({ id, cwd: directory, createdAt: 1, updatedAt: 1,
        name: `Synthetic ${id}`, status: { type: 'idle' } }));
    const writes: string[] = [];
    const rpc = {
        get online() { return online; }, currentGeneration: 1, supportsThreadWriterLock: true,
        connect: async () => {
            if (!online) attempts++;
            if (!available) throw new SourceError('TARGET_UNAVAILABLE', 'Synthetic source outage');
            online = true;
            return {};
        },
        dispose: async () => {}, onNotification: () => () => {}, onRequest: () => () => {},
        onDisconnect: (listener: () => void) => { disconnected = listener; return () => { disconnected = () => {}; }; },
        request: async (method: string, params: Record<string, unknown>, options?: { write?: boolean }): Promise<unknown> => {
            assert.equal(online, true, 'source reads must pass through the shared reconnect probe');
            if (options?.write) writes.push(method);
            if (method === 'thread/loaded/list') return { data: threads.map(thread => thread.id), nextCursor: null };
            if (method === 'thread/list') return { data: threads, nextCursor: null };
            if (method === 'thread/read') return { thread: threads.find(thread => thread.id === params.threadId) };
            if (method === 'thread/turns/list') return { data: [], nextCursor: null };
            throw new Error(`Unexpected recovery request: ${method}`);
        },
    } as unknown as CodexRpc;
    const adapter = new DirectCodexAdapter({ id: 'native', machineId: 'machine', engine: 'codex' }, directory,
        { rpc, readMetadata: nativeMetadataFixture(() => []), now: () => now, random: () => 1 });
    t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); });
    const sessions = await adapter.list();
    for (const session of sessions) await adapter.read({ sessionId: session.id });
    const advance = async (ms: number): Promise<void> => { now += ms; t.mock.timers.tick(ms); await flush(); await flush(); };

    available = false; online = false; disconnected();
    const offline = await adapter.read({ sessionId: sessions[0]!.id });
    assert.equal(offline.session.connection?.state, 'offline');
    assert.equal(offline.session.status, 'idle', 'a disconnected source retains its last native execution state');
    assert.deepEqual(offline.session.capabilities, sessions[0]!.capabilities, 'disconnect must not revoke the native send capability');
    await advance(250);
    assert.equal(attempts, 0, 'the 250 ms history poll must not immediately reconnect');
    assert.equal((await adapter.read({ sessionId: sessions[0]!.id })).entries.length, 0, 'a prepared history remains available during cooldown');
    await advance(250);
    assert.equal(attempts, 1, 'both native threads share the first source probe');
    await assert.rejects(adapter.list(), { code: 'TARGET_UNAVAILABLE' });
    assert.equal(attempts, 1, 'catalog polling cannot bypass the source cooldown');
    await advance(750);
    assert.equal(attempts, 1);
    await advance(250);
    assert.equal(attempts, 2);
    for (const ms of [2000, 4000, 8000, 16_000, 30_000, 30_000]) {
        const before = attempts;
        await advance(ms - 250);
        assert.equal(attempts, before, 'background ticks must respect the increasing, capped delay');
        await advance(250);
        assert.equal(attempts, before + 1);
    }

    available = true;
    await advance(30_000);
    assert.equal(online, true);
    assert.equal((await adapter.read({ sessionId: sessions[0]!.id })).session.status, 'idle');
    assert.equal((await adapter.read({ sessionId: sessions[0]!.id })).session.connection?.state, 'online');
    const recovered = attempts;
    available = false; online = false; disconnected();
    await advance(250);
    assert.equal(attempts, recovered);
    await advance(250);
    assert.equal(attempts, recovered + 1, 'successful native reading resets the next outage to the minimum delay');
    assert.deepEqual(writes, [], 'read recovery never replays a native mutation');
    await adapter.dispose();
    await advance(60_000);
    assert.equal(attempts, recovered + 1, 'disposing the source releases its recovery loop');
});
