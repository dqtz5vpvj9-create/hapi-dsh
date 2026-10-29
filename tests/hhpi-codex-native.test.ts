/** Actual Codex 0.165.0 process; only the external model Responses API is a local fixture. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import type { SourcePage } from '../src/remote/protocol.ts';
import { SyntheticResponsesModel } from './fixtures/hhpi/model.ts';

const script = process.env.HHPI_CODEX_TEST_SCRIPT;
const command = process.env.HHPI_CODEX_TEST_COMMAND;
test('native Codex creates once, sends, streams, pages, steers and interrupts without a DSH execution Session', {
    skip: !script && !command ? 'Set HHPI_CODEX_TEST_COMMAND or HHPI_CODEX_TEST_SCRIPT to the pinned native Codex 0.165.0 executable.' : false,
    timeout: 45_000,
}, async () => {
    const root = await mkdtemp(join(tmpdir(), 'hhpi-native-'));
    const model = new SyntheticResponsesModel(); await model.start();
    await writeFile(join(root, 'config.toml'), model.config());
    const source = new DirectCodexAdapter({ id: 'synthetic', machineId: 'fixture-machine', engine: 'codex', command: script ? process.execPath : command!,
        args: script ? [script, 'app-server'] : ['app-server'], codexHome: root, cwd: root, ownership: 'exclusive' }, join(root, 'source-index'));
    const signal = AbortSignal.timeout(40_000);
    try {
        assert.equal((await source.list()).length, 0);
        const creation = { sourceId: source.id, operationId: 'one-creation', cwd: root };
        const [a, b] = await Promise.all([source.create(creation), source.create(creation)]);
        assert.equal(a.status, 'accepted'); assert.ok(a.session); assert.deepEqual(a, b);
        const sessionId = a.session.id;
        const initial = await source.read({ sessionId }); assert.equal(initial.entries.length, 0);
        assert.equal((await source.list()).length, 1);
        let accepted = initial;
        const completed = async (page: SourcePage, nativeTurnId: string): Promise<SourcePage> => {
            for await (const change of source.changes({ sessionId, epoch: page.epoch, version: page.version }, signal)) {
                if (!change.upserts.some(entry => entry.event.type === 'turn/end')) continue;
                const current = await source.read({ sessionId, limit: 500 });
                // A replay or revision of an older completed turn cannot complete this send.
                let coordinate: number | undefined; let found = false;
                for (const entry of current.entries) {
                    if (entry.event.type === 'turn/start') coordinate = (entry.event.data as { turn: number }).turn;
                    if (entry.event.type === 'user/message' && (entry.event.data as { id: string }).id.includes(`:${encodeURIComponent(nativeTurnId)}:`)) { found = true; break; }
                }
                if (found && coordinate !== undefined && current.entries.some(entry => entry.event.type === 'turn/end' && (entry.event.data as { turn: number }).turn === coordinate)) return current;
            }
            throw new Error('The native turn ended without a source completion event');
        };
        for (let turn = 0; turn < 8; turn++) {
            const operation = { sessionId, operationId: `send-${turn}`, kind: 'send' as const, text: `Synthetic prompt ${turn}` };
            const [first, duplicate] = await Promise.all([source.operate(operation), source.operate(operation)]);
            assert.equal(first.status, 'accepted'); assert.deepEqual(first, duplicate);
            assert.ok(first.turnId); accepted = await completed(accepted, first.turnId);
        }
        assert.equal(model.calls, 8, 'duplicate submissions must reach the native model only once');
        const identities = accepted.entries.map(entry => entry.event.seq);
        assert.equal(new Set(identities).size, identities.length);
        assert.equal(accepted.entries.filter(entry => entry.event.type === 'user/message').length, 8);
        assert.equal(accepted.entries.filter(entry => entry.event.type === 'assistant/message').length, 8);
        let page = await source.read({ sessionId, limit: 6 });
        for (let segment = 0; segment < 6; segment++) {
            assert.ok(page.before !== null);
            const older = await source.read({ sessionId, before: page.before, epoch: page.epoch, limit: 6 });
            assert.ok(older.entries.some(entry => entry.event.type === 'user/message' || entry.event.type === 'assistant/message'), `segment ${segment + 1} must contain body text`);
            assert.ok(older.before! < page.before); page = older;
        }
        // Hold only the model boundary; native steering and execution ownership remain real.
        model.automatic = false;
        const running = await source.operate({ sessionId, operationId: 'running', kind: 'send', text: 'Wait for synthetic feedback.' });
        assert.equal(running.status, 'accepted'); assert.ok(running.turnId);
        const held = await model.next(signal);
        const steering = { sessionId, operationId: 'steer', kind: 'steer' as const, text: 'Additional synthetic feedback.', turnId: running.turnId };
        const steer = await source.operate(steering);
        assert.equal(steer.status, 'accepted'); assert.deepEqual(await source.operate(steering), steer);
        model.automatic = true; held.reply('Synthetic steered completion');
        accepted = await completed(accepted, running.turnId);
        model.automatic = false;
        const cancellable = await source.operate({ sessionId, operationId: 'cancellable', kind: 'send', text: 'Wait for synthetic cancellation.' });
        assert.equal(cancellable.status, 'accepted'); assert.ok(cancellable.turnId);
        await model.next(signal);
        const cancel = { sessionId, operationId: 'cancel', kind: 'cancel' as const, turnId: cancellable.turnId };
        const cancelled = await source.operate(cancel); assert.equal(cancelled.status, 'accepted');
        assert.deepEqual(await source.operate(cancel), cancelled);
        await completed(accepted, cancellable.turnId);
        const final = await source.read({ sessionId, limit: 500 });
        assert.deepEqual(final.entries.filter(entry => identities.includes(entry.event.seq)).map(entry => entry.event.seq), identities, 'native streaming and later turns preserve earlier source identities');
        await assert.rejects(source.read({ sessionId: sessionId.replace('fixture-machine', 'other-machine') }), { code: 'INVALID_REQUEST' });
    } finally { await source.dispose(); await model.close(); await rm(root, { recursive: true, force: true }); }
});
