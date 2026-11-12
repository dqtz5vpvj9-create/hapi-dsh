import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import type { ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client';
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules';
import { syncDeferredStages, workspaceDeferredDemand } from '../src/client/deferred-plugins.ts';
import type { WorkspaceController } from '../src/client/controller.ts';
import { assertStableBootEntries, workspaceBootGraph, workspaceResourceBootGraph } from '../src/shared/boot-graph.ts';
import { createGraphModules } from '../src/client/graph-document.ts';
import { prepareOfficialBrowserLibrary, resolveOfficialBrowserDependency } from './contracts/official-browser-library.ts';

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { fixtureResource: 'title' } }

const modules = '@deepseek-ai/dsh-client-modules';
const account = '@deepseek-ai/dsh-client-ui-settings-account';
const schedule = '@deepseek-ai/dsh-client-product-analytics';
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

/** Actual pinned module reconciliation/Cordis/locale; editor and source binding
 * are explicit DOM/protocol fixtures. This is not real layout/browser evidence. */
test('official cumulative resource activation and late locale keep the focused reader draft and source owner', async () => {
    const require = createRequire(import.meta.url);
    const { JSDOM } = require('jsdom') as { JSDOM: new (html: string, options: { url: string }) => { window: { document: Document; close(): void } } };
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://fixture.invalid/' });
    const ctx = new Context(), document = dom.window.document;
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const previousCss = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
    Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: (value: string) => value } });
    try {
        let selectedResource: { kind: string; sessionId?: string } = { kind: 'empty' };
        const workspace = { store: { focusedPane: () => ({ id: 'p1', resource: selectedResource }), subscribe: () => () => {} },
            getSnapshot: () => ({ catalogDiscovery: { hosts: [] }, catalog: { byId: { 'readonly-thread': { projectionValues: { hhpiSource: { capabilities: { send: false } } } } } } }) } as unknown as WorkspaceController;
        const demand = workspaceDeferredDemand(workspace);
        assert.equal(demand(), 'ready', 'an empty workspace can load independent views');
        selectedResource = { kind: 'terminal', sessionId: 'readonly-thread' };
        assert.equal(demand(), 'requested', 'explicit/restored resources bypass unfinished chat and idle');
        selectedResource = { kind: 'chat', sessionId: 'readonly-thread' };
        const readonly = document.createElement('section'); readonly.dataset.hapiPaneInstance = 'p1';
        readonly.append(Object.assign(document.createElement('article'), { textContent: 'Source-readable body' }));
        readonly.firstElementChild!.setAttribute('data-chat-node-key', 'source-body'); document.body.append(readonly);
        assert.equal(demand(), 'ready', 'a legitimate readonly reader does not need a composer'); readonly.remove();
        await prepareOfficialBrowserLibrary();
        let registration: { factory: (require: unknown) => typeof import('@deepseek-ai/dsh-client-locale/client') } | undefined;
        new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-client-locale/client'), 'utf8'))({ __ModuleLoader__: { load(value: typeof registration) { registration = value; } } });
        const { LocaleRuntime } = registration!.factory(resolveOfficialBrowserDependency);
        const locale = new LocaleRuntime(ctx);
        const official = createGraphModules(document, readFileSync(require.resolve('@deepseek-ai/dsh-client-modules/client'), 'utf8'));
        const core = 'fixture-conversation', files = '@deepseek-ai/dsh-client-ui-sidebar-files';
        const full: WebBootGraph = { rev: 'same-release', entries: [modules, core, files].map(id => ({ id, rev: 'r1', url: '/plugins/' + id })), batches: [] };
        full.entries[2]!.inject = [core];
        full.batches = full.entries.map(row => ({ phase: 'application', url: row.url, rev: row.rev, entries: [row.id] }));
        const initial = workspaceBootGraph(full), resource = workspaceResourceBootGraph(full);
        const binding = { nativeId: 'original-thread', pending: ['original-queue-item'] };
        let mounts = 0, stops = 0, resourceAttempts = 0;
        const editor = document.createElement('input'), body = document.createElement('article');
        editor.value = '中文草稿，尚未发送'; body.textContent = 'Accepted original source body';
        const target: ClientModuleLoaderTarget = { mode: 'queue', pendingQueue: [], load() {}, create() { throw new Error('Use the official module factory'); } };
        const system = official.createClientModuleSystem(target, { id: modules, exports: official as unknown as Record<string, unknown> }, {
            boot: initial, staticModules: {}, async loadBundle(url) {
                const id = full.entries.find(row => row.url === url)!.id;
                target.load({ id, factory: () => ({ apply(owner: Context) {
                    if (id === core) return owner.effect(() => {
                        mounts++; document.body.append(body, editor); editor.focus();
                        owner.reflect.provide('fixtureReader' as never, binding as never);
                        return () => { stops++; body.remove(); editor.remove(); };
                    });
                    if (++resourceAttempts === 1) throw new Error('Intentional independent resource activation failure');
                    return owner.effect(() => locale.register('fixtureResource', { en: { title: 'Files' }, zh: { title: '文件' } }));
                } }) });
            },
        });
        await ctx.plugin(Loader); ctx.loader.internal = system as never;
        await system.entries.start(ctx.loader, system.manifest);
        const fiber = [...ctx.loader.entries()].find(entry => entry.options.name === core)!.fiber;
        const reached = deferred(), release = deferred(), revision = locale.getSnapshot().revision;
        const sync = syncDeferredStages(full, { signal: new AbortController().signal, stages: [resource], requested: () => false, idle: async () => {},
            async preload() { reached.resolve(); await release.promise; },
            async sync(graph) { assertStableBootEntries(graph, system.manifest.modules); await system.entries.sync(graph); },
        });
        await reached.promise;
        assert.equal(mounts, 1); assert.equal(document.activeElement, editor);
        release.resolve(); await sync;
        assert.equal(system.entries.state.getSnapshot().failures.length, 1, 'the independent failure stays explicit');
        assert.equal(document.activeElement, editor); assert.equal(editor.value, '中文草稿，尚未发送');
        assert.equal(stops, 0, 'failed independent activation cannot retire the running reader');
        await system.entries.sync(resource); // A subsequent explicit resource demand retries its original entry.
        assert.ok(locale.getSnapshot().revision > revision, 'the late official dictionary actually published a revision');
        assert.equal([...ctx.loader.entries()].find(entry => entry.options.name === core)!.fiber, fiber);
        assert.equal(Reflect.get(ctx, 'fixtureReader'), binding);
        assert.equal(document.activeElement, editor); assert.equal(editor.value, '中文草稿，尚未发送');
        assert.equal(document.querySelector('article'), body); assert.deepEqual(binding.pending, ['original-queue-item']);
        assert.equal(mounts, 1); assert.equal(stops, 0); assert.deepEqual(system.entries.state.getSnapshot().failures, []);
    } finally {
        await ctx.fiber.dispose();
        if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
        if (previousCss) Object.defineProperty(globalThis, 'CSS', previousCss); else Reflect.deleteProperty(globalThis, 'CSS');
        dom.window.close();
    }
});
