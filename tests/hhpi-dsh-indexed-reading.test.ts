/** Installed indexed JSONL provider + production HHPI native DSH adapter.
 * Only authenticated source-owner HTTP is synthetic; original event files,
 * source workers, page dependencies and persisted revision state are real. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, createToolResultMessage, ToolCallId, MessageId } from '@deepseek-ai/dsh-llm';
import { apply as persistence } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { DirectDshAdapter } from '../src/remote/dsh-adapter.ts';
import { DirectDshHistory } from '../src/remote/dsh-history.ts';
import { sourceSessionId, type DirectDshConfig, type SourcePage, type SourceSession } from '../src/remote/protocol.ts';

const nativeId = 'indexed-native-session', createdAt = 1800000000000;
const identity = { sourceId: 'native-dsh', machineId: 'indexed-machine', engine: 'dsh', nativeId };
const id = sourceSessionId(identity);
const user = (seq: number, text = `Original readable body ${seq}`): SessionEvent => ({ type: 'user/message', seq: SessionSeq(seq), time: createdAt + seq,
    surfaceOp: 'append', data: { id: MessageId(`user-${seq}`), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } });
function events(variant = 'original'): SessionEvent[] {
    const result: SessionEvent[] = [];
    const put = (type: string, data: unknown, surfaceOp?: 'append') => result.push({ type, seq: SessionSeq(result.length), time: createdAt + result.length,
        data, ...(surfaceOp ? { surfaceOp } : {}) } as SessionEvent);
    for (let block = 0; block < 16; block++) {
        const turn = block + 1, step = 1, callId = ToolCallId(`tool-${block}`);
        put('turn/start', { turn }); put('step/start', { turn, step });
        put('assistant/message', { turn, step, stream: [], message: createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name: 'fixture_tool', arguments: '{}' }],
            source: { provider: 'fixture', model: 'fixture' } }) }, 'append');
        put('tool/call', { turn, step, callId, name: 'fixture_tool', arguments: '{}' });
        put('tool/result', { turn, step, message: createToolResultMessage({ callId, content: [{ type: 'text', text: `${variant} tool result ${block}` }], isError: false }) }, 'append');
        put('step/end', { turn, step }); put('turn/end', { turn, reason: { kind: 'completed' } });
        for (let item = 0; item < 153; item++) result.push(user(result.length, `${variant} readable body ${result.length}`));
    }
    return result;
}
function body(page: SourcePage): number[] {
    const context = new Set(page.context);
    return page.entries.filter(entry => !context.has(entry.event.seq)).map(entry => Number(entry.event.seq));
}
async function nativePath(root: string): Promise<string> {
    const found: string[] = [];
    async function scan(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await scan(path);
            else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) found.push(path);
        }
    }
    await scan(root);
    assert.equal(found.length, 1, 'the fixture owns one actual native Session file');
    return found[0]!;
}
async function fixture(t: TestContext, initial = events()) {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-dsh-indexed-'), root = join(directory, 'sessions'), ownerContext = new Context();
    await ownerContext.plugin(persistence, { root, compression: 'zstd' });
    const header: SessionHeader = { id: SessionId(nativeId), version: SESSION_FORMAT_VERSION, createdAt, cwd: '/synthetic-indexed', isSeeded: false };
    const writer = await ownerContext.sessionPersistence.create(header);
    await writer.append(initial); await writer.flush();
    const config: DirectDshConfig = { id: identity.sourceId, machineId: identity.machineId, engine: 'dsh', root,
        owner: { hubId: 'fixture-owner', url: 'http://indexed-owner.fixture', tokenEnv: 'INDEXED_FIXTURE_TOKEN' } };
    const metadata = { name: 'Original indexed conversation', path: '/synthetic-indexed', flavor: 'dsh', machineId: identity.machineId, dshSessionId: nativeId };
    const row = { id: 'original-owner', metadata, active: true, thinking: false, activeAt: createdAt, updatedAt: createdAt,
        metadataVersion: 1, agentStateVersion: 0, namespace: 'fixture', seq: 0, createdAt, thinkingAt: 0, agentState: {} };
    const ownerRequests: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(String(input)); ownerRequests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (url.pathname === '/api/auth') return Response.json({ token: 'fixture-session-token' });
        if (url.pathname === '/api/sessions') {
            const { dshSessionId: _native, ...summary } = metadata;
            return Response.json({ sessions: [{ ...row, metadata: summary }] });
        }
        if (url.pathname === '/api/sessions/original-owner') return Response.json({ session: row });
        throw new Error(`Unexpected indexed source-owner request ${url.pathname}`);
    };
    const make = () => new DirectDshAdapter(config, join(directory, 'derived'), { env: { INDEXED_FIXTURE_TOKEN: 'fixture-only' }, fetch: fetcher });
    const adapters = new Set<DirectDshAdapter>();
    const open = () => { const adapter = make(); adapters.add(adapter); return adapter; };
    const close = async (adapter: DirectDshAdapter) => { if (adapters.delete(adapter)) await adapter.dispose(); };
    t.after(async () => { for (const adapter of [...adapters]) await close(adapter); await writer.close(); await ownerContext.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
    return { directory, root, writer, header, initial, open, close, metadata, ownerRequests };
}

test('cold indexed DSH opening returns one native page and six more contiguous pages without a full transcript snapshot', { timeout: 15000 }, async t => {
    const f = await fixture(t), adapter = f.open();
    t.mock.method(DirectDshHistory.prototype, 'snapshot', async () => { throw new Error('Opening a native page must not materialize a full transcript'); });
    let page = await adapter.read({ sessionId: id, limit: 160 });
    assert.equal(page.hasBefore, true);
    const first = page, collected = new Set<number>();
    for (let index = 0; index < 7; index++) {
        const original = body(page);
        assert.equal(original.length, 160);
        assert.deepEqual(original, Array.from({ length: 160 }, (_, offset) => f.initial.length - (index + 1) * 160 + offset));
        assert.ok(page.entries.some(entry => entry.event.type === 'user/message'), 'every real page contains readable original body');
        assert.equal(page.version, first.version); assert.equal(page.epoch, first.epoch);
        for (const seq of original) { assert.equal(collected.has(seq), false); collected.add(seq); }
        if (index < 6) page = await adapter.read({ sessionId: id, before: page.before!, epoch: first.epoch, limit: 160 });
    }
    assert.equal(collected.size, 1120);
    assert.equal(f.ownerRequests.some(path => path.endsWith('/messages')), false, 'native body reading cannot go through HAPI messages');
    assert.equal(f.writer.access, 'write', 'HHPI never takes native execution ownership');
});

test('an indexed tool result carries exact original turn, step, assistant and call dependencies without moving its body cursor', { timeout: 10000 }, async t => {
    const f = await fixture(t), adapter = f.open(), block = 8, resultSeq = block * 160 + 4;
    const page = await adapter.read({ sessionId: id, around: resultSeq, limit: 1 });
    assert.deepEqual(body(page), [resultSeq]);
    assert.equal(page.before, resultSeq); assert.equal(page.after, resultSeq);
    assert.deepEqual(page.context, [block * 160, block * 160 + 1, block * 160 + 2, block * 160 + 3]);
    assert.deepEqual(page.entries.map(entry => entry.event), page.entries.map(entry => f.initial[entry.event.seq]));
    assert.equal(page.entries.at(-1)?.event.type, 'tool/result');
});

test('concurrent native appends cannot starve a fixed-prefix page and later reads expose the new original events', { timeout: 15000 }, async t => {
    const f = await fixture(t), adapter = f.open();
    const pending = adapter.read({ sessionId: id, limit: 160 });
    await new Promise<void>(resolve => setImmediate(resolve));
    const count = f.initial.length;
    const appending = (async () => {
        for (let offset = 0; offset < 16; offset++) {
            await f.writer.append([user(count + offset, `Append accepted ${offset}`)]);
            await f.writer.flush();
        }
    })();
    const first = await pending;
    const seqs = body(first);
    assert.equal(seqs.length, 160);
    assert.deepEqual(seqs, Array.from({ length: 160 }, (_, index) => seqs[0]! + index));
    await appending;
    const updated = await adapter.read({ sessionId: id, limit: 160 });
    assert.equal(updated.after, count + 15);
    assert.equal(updated.epoch, first.epoch, 'ordinary append is the same native generation');
    assert.match(JSON.stringify(updated.entries), /Append accepted 15/);
});

test('adapter restart reuses its durable source epoch/version and metadata-only updates produce a non-reset change', { timeout: 15000 }, async t => {
    const f = await fixture(t);
    let adapter = f.open();
    const initial = await adapter.read({ sessionId: id });
    await f.close(adapter);
    const ownerBaseline = f.ownerRequests.length;
    adapter = f.open();
    const reopened = await adapter.read({ sessionId: id });
    assert.deepEqual(f.ownerRequests.slice(ownerBaseline).filter(request => request.startsWith('GET ')),
        ['GET /api/sessions/original-owner'],
        'a restarted adapter revalidates only its persisted exact owner, without listing or inspecting unrelated sessions');
    assert.equal(reopened.epoch, initial.epoch); assert.equal(reopened.version, initial.version);
    assert.deepEqual(reopened.entries, initial.entries);
    await f.close(adapter);
    f.metadata.name = 'Updated indexed conversation title';
    adapter = f.open();
    const renamed = await adapter.read({ sessionId: id });
    assert.equal(renamed.epoch, initial.epoch); assert.ok(renamed.version > initial.version);
    const stop = new AbortController(), stream = adapter.changes({ sessionId: id, epoch: initial.epoch, version: initial.version }, stop.signal)[Symbol.asyncIterator]();
    try {
        const change = await stream.next();
        assert.equal(change.done, false); assert.equal(change.value?.reset, false);
        assert.deepEqual(change.value?.upserts, []);
        assert.equal(change.value?.session.title, f.metadata.name);
    } finally { stop.abort(); await stream.return?.(); }
    await f.close(adapter);
    adapter = f.open();
    const stable = await adapter.read({ sessionId: id });
    assert.equal(stable.epoch, renamed.epoch); assert.equal(stable.version, renamed.version);
});

test('a true native file replacement invalidates old cursors even with identical event count and header creation time', { timeout: 15000 }, async t => {
    const f = await fixture(t), adapter = f.open();
    const original = await adapter.read({ sessionId: id });
    await f.writer.close();
    const replacementRoot = join(f.directory, 'replacement'), replacementContext = new Context();
    await replacementContext.plugin(persistence, { root: replacementRoot, compression: 'zstd' });
    const replacement = await replacementContext.sessionPersistence.create(f.header), rewritten = events('rewritten');
    try { await replacement.append(rewritten); await replacement.flush(); } finally { await replacement.close(); await replacementContext.fiber.dispose(); }
    assert.equal(rewritten.length, f.initial.length);
    const target = await nativePath(f.root), source = await nativePath(replacementRoot), incoming = join(f.directory, 'replacement-native-file');
    await writeFile(incoming, await readFile(source)); await rename(incoming, target);
    await assert.rejects(adapter.read({ sessionId: id, epoch: original.epoch, before: original.before!, limit: 160 }), { code: 'STALE_VERSION' });
    const changed = await adapter.read({ sessionId: id });
    assert.notEqual(changed.epoch, original.epoch);
    assert.match(JSON.stringify(changed.entries), /rewritten readable body/);
});

test('cancelling or disposing indexed native reads stops their source work and leaves the original writer usable', { timeout: 10000 }, async t => {
    const f = await fixture(t), reader = new DirectDshHistory(f.root);
    t.after(() => reader.dispose());
    const source: SourceSession = { ...identity, id, title: 'Indexed reader cancellation', cwd: '/synthetic-indexed', updatedAt: createdAt,
        status: 'idle', activeTurnId: null, capabilities: { send: false, steer: false, cancel: false, approve: false, files: false }, pendingRequests: [] };
    const abort = new AbortController(), cancelled = reader.read(source, { sessionId: id, limit: 160 }, abort.signal);
    void cancelled.catch(() => {});
    await new Promise<void>(resolve => setImmediate(resolve));
    abort.abort(new Error('Indexed Pane released'));
    await assert.rejects(cancelled, /Indexed Pane released/);
    const disposing = reader.read(source, { sessionId: id, limit: 160 });
    void disposing.catch(() => {});
    await new Promise<void>(resolve => setImmediate(resolve));
    await reader.dispose();
    await assert.rejects(disposing, /disposed|cancel|terminated/i);
    await assert.rejects(reader.read(source, { sessionId: id }), { code: 'DISPOSED' });
    await f.writer.append([user(f.initial.length, 'Original writer survives cancelled readers')]); await f.writer.flush();
    const stored = await f.writer.read(f.initial.length, 1);
    assert.equal(stored.events[0]?.seq, f.initial.length);
});
