import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceTitleController } from '../src/client/source-title.ts';
import type { SessionExtrasApi, WorkbenchSource } from '../src/client-api.ts';
const source: WorkbenchSource = { sourceHubId: 'source-hub', sourceSessionId: 'source-session', machineId: 'machine' };
function fixture() {
    const memory = new Map<string, string>(), storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
    const state = { title: 'Original title', available: true, generations: 0, writes: 0, loseReply: false, readFails: false };
    const api: Pick<SessionExtrasApi, 'sourceTitleTools' | 'sourceTitleSuggestion'> = {
        sourceTitleTools: async () => { if (state.readFails) throw new Error('source disconnected'); return { ok: true, value: { title: state.title, suggestionAvailable: state.available } }; },
        sourceTitleSuggestion: async () => { state.generations++; return { ok: true, value: { title: 'A generated suggestion' } }; },
    };
    const rename = async (title: string) => { state.writes++; state.title = title; if (state.loseReply) throw new Error('source reply lost'); };
    return { state, storage, api, rename, create: () => new SourceTitleController(api, source, rename, storage) };
}
test('a source-generated title is only an editable suggestion until explicitly saved', async () => {
    const env = fixture(), controller = env.create(); await controller.refresh(); await controller.suggest();
    assert.equal(env.state.generations, 1); assert.equal(env.state.writes, 0);
    assert.equal(controller.getSnapshot().draft?.title, 'A generated suggestion');
    controller.setTitle('My edited suggestion'); await controller.apply();
    assert.equal(env.state.title, 'My edited suggestion'); assert.equal(env.state.writes, 1);
    assert.equal(controller.getSnapshot().status, 'confirmed');
    env.state.available = false; await controller.refresh(); await controller.suggest(); assert.equal(env.state.generations, 1);
});
test('a lost original rename reply recovers by reading after reload, without another rename or suggestion', async () => {
    const env = fixture(), controller = env.create(); controller.setTitle('Retain the original request');
    env.state.loseReply = true; env.state.readFails = true; await controller.apply();
    assert.equal(controller.getSnapshot().draft?.pending, true); assert.equal(env.state.writes, 1);
    const recovered = env.create(); env.state.readFails = false; await recovered.refresh();
    assert.equal(recovered.getSnapshot().status, 'observed'); assert.equal(recovered.getSnapshot().draft, null);
    assert.equal(env.state.writes, 1); assert.equal(env.state.generations, 0);
});
test('title changes cannot dispatch when durable browser request storage is unavailable', async () => {
    const env = fixture(); const controller = new SourceTitleController(env.api, source, env.rename, { getItem: () => null, setItem: () => { throw new Error('quota exceeded'); } });
    controller.setTitle('Not saved'); await controller.apply(); assert.equal(env.state.writes, 0); assert.match(controller.getSnapshot().error ?? '', /quota/);
});
