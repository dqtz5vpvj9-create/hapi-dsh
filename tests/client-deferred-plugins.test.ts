import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules';
import { syncDeferredStages } from '../src/client/deferred-plugins.ts';

const modules = '@deepseek-ai/dsh-client-modules';
const account = '@deepseek-ai/dsh-client-ui-settings-account';
const schedule = '@deepseek-ai/dsh-client-ui-schedule';
const hmr = '@deepseek-ai/dsh-client-hmr';
function graph(): WebBootGraph {
    return { rev: 'fixture', entries: [modules, 'hapi-dsh', account, schedule, hmr].map(id => ({ id, rev: id, url: `plugins/${id}?rev=fixture` })),
        batches: [{ phase: 'bootstrap', url: 'plugins/bootstrap', rev: 'boot', entries: [modules] },
            { phase: 'application', url: 'plugins/application', rev: 'application', entries: ['hapi-dsh', account, schedule, hmr] }] };
}
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

test('reader input dispatched after an in-flight stage pauses the next stage', async () => {
    const reachedIdle = deferred(), releaseReader = deferred(), calls: WebBootGraph[] = [];
    let busy = false;
    const work = syncDeferredStages(graph(), {
        preload: async () => {}, signal: new AbortController().signal, requested: () => false,
        async sync(stage) {
            calls.push(stage);
            if (calls.length === 1) setTimeout(() => { busy = true; }, 0);
        },
        async idle() { if (busy) { reachedIdle.resolve(); await releaseReader.promise; busy = false; } },
    });
    await reachedIdle.promise;
    assert.equal(calls.length, 1, 'the completed entry is retained while a new gesture owns the foreground');
    assert.ok(!calls[0]!.entries.some(row => row.id === schedule));
    releaseReader.resolve(); await work;
    assert.deepEqual(calls.at(-1)!.entries.map(row => row.id), graph().entries.map(row => row.id));
});

test('opening a panel during a stage requests the full roster at the next boundary', async () => {
    const full = graph(), calls: WebBootGraph[] = [];
    let requested = false;
    await syncDeferredStages(full, {
        preload: async () => {}, signal: new AbortController().signal, requested: () => requested, idle: async () => {},
        async sync(stage) { calls.push(stage); requested = true; },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.entries, full.entries, 'explicit panel demand bypasses the remaining background stages');
});

test('disposing after a stage leaves it installed and prevents subsequent reconciliation', async () => {
    const controller = new AbortController(), calls: WebBootGraph[] = [];
    const work = syncDeferredStages(graph(), {
        preload: async () => {}, signal: controller.signal, requested: () => false, idle: async () => {},
        async sync(stage) { calls.push(stage); controller.abort(new Error('disposed')); },
    });
    await assert.rejects(work, /disposed/);
    assert.equal(calls.length, 1);
});

test('a rejected official reconciliation ends the background task without starting another stage', async () => {
    let calls = 0;
    await assert.rejects(syncDeferredStages(graph(), {
        preload: async () => {}, signal: new AbortController().signal, requested: () => false, idle: async () => {},
        async sync() { calls++; throw new Error('release unavailable'); },
    }), /release unavailable/);
    assert.equal(calls, 1);
});


test('a gesture started during download delays activation of that same stage', async () => {
    const arrived = deferred(), releaseDownload = deferred(), blockedActivation = deferred(), releaseReader = deferred();
    const downloads: WebBootGraph[] = [], activations: WebBootGraph[] = [];
    let busy = false;
    const work = syncDeferredStages(graph(), {
        signal: new AbortController().signal, requested: () => false,
        async preload(stage) {
            downloads.push(stage);
            if (downloads.length === 1) { arrived.resolve(); await releaseDownload.promise; }
        },
        async idle() { if (busy) { blockedActivation.resolve(); await releaseReader.promise; busy = false; } },
        async sync(stage) { activations.push(stage); },
    });
    await arrived.promise;
    busy = true; releaseDownload.resolve();
    await blockedActivation.promise;
    assert.equal(activations.length, 0, 'download completion cannot activate a plugin during the new gesture');
    releaseReader.resolve(); await work;
    assert.deepEqual(activations, downloads, 'every downloaded stage still reaches official activation');
});

test('disposing during download prevents activation when the resource arrives', async () => {
    const arrived = deferred(), releaseDownload = deferred(), controller = new AbortController();
    let activations = 0;
    const work = syncDeferredStages(graph(), {
        signal: controller.signal, requested: () => false, idle: async () => {},
        async preload() { arrived.resolve(); await releaseDownload.promise; },
        async sync() { activations++; },
    });
    await arrived.promise;
    controller.abort(new Error('disposed')); releaseDownload.resolve();
    await assert.rejects(work, /disposed/);
    assert.equal(activations, 0);
});
