import assert from 'node:assert/strict';
import test from 'node:test';
import { bootInjections } from '@deepseek-ai/dsh-client-modules';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createGraphModules } from '../src/client/graph-document.ts';
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules';
import { workspaceBootGraph, deferredBootStages, independentBootBatches, stageWorkspaceBoot } from '../src/shared/boot-graph.ts';

const { parseBootManifest } = createGraphModules({} as Document,
    readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-modules/client'), 'utf8'));

const modules = '@deepseek-ai/dsh-client-modules';
const account = '@deepseek-ai/dsh-client-ui-settings-account';
const hmr = '@deepseek-ai/dsh-client-hmr';
const models = '@deepseek-ai/dsh-client-ui-settings-models';
const cordisRunner = '@deepseek-ai/dsh-cordis-client-runner';
const entryCustomization = '@deepseek-ai/dsh-client-ui-entry-customization';
const pluginManager = '@deepseek-ai/dsh-client-ui-plugin-manager';
const require = createRequire(import.meta.url);
function graph(): WebBootGraph {
    return { rev: 'fixture', entries: [modules, 'hapi-dsh', account, hmr].map(id => ({ id, rev: id, url: `plugins/${id}/client.js?rev=fixture` })),
        batches: [{ phase: 'bootstrap', url: 'plugins/bootstrap.js', rev: 'boot', entries: [modules] },
            { phase: 'application', url: 'plugins/full.js', rev: 'full', entries: ['hapi-dsh', account, hmr] }] };
}

test('cold carrier excludes settings assets but preserves every official factory and its own cache identity', () => {
    const full = graph(), first = workspaceBootGraph(full);
    assert.deepEqual(first.entries.map(row => row.id), [modules, 'hapi-dsh']);
    assert.equal(full.entries.length, 4);
    assert.ok(first.entries.every(row => full.entries.includes(row)));
    assert.doesNotThrow(() => parseBootManifest(first));
    const resumed = independentBootBatches(full);
    assert.doesNotThrow(() => parseBootManifest(resumed));
    assert.ok(resumed.batches.filter(row => row.phase === 'application').every(row => row.entries.length === 1));
    assert.equal(resumed.entries, full.entries);
});

test('custom plugin dependencies keep optional pages in the first roster when they are actually required', () => {
    const full = graph();
    full.entries[1]!.external = [`${account}/client`];
    full.entries[2]!.inject = [hmr];
    assert.equal(workspaceBootGraph(full).entries.length, 4);
});

test('index composition removes the old combo preload, keeps bootstrap and unrelated contributions', () => {
    const full = graph(), table = bootInjections(full);
    table.push({ kind: 'script-preload', src: 'unrelated.js' });
    stageWorkspaceBoot(table, full);
    const urls = table.filter(row => row.kind === 'script-preload').map(row => row.src);
    assert.ok(!urls.includes('plugins/full.js'));
    assert.ok(urls.includes('unrelated.js'));
    assert.ok(urls.includes(full.entries[1]!.url));
    assert.ok(table.some(row => row.kind === 'script-src' && row.src === 'plugins/bootstrap.js'));
    const injected = table.find(row => row.kind === 'global' && row.name === '__DSH_BOOT__');
    assert.ok(injected?.kind === 'global');
    assert.doesNotThrow(() => parseBootManifest(injected.value));
});

/** Installed pinned manifests supply actual dependencies; the carrier itself is
 * synthetic. This does not boot or replace the official browser runtime. */
function officialGraph(): WebBootGraph {
    const entries = new Map<string, WebBootGraph['entries'][number]>();
    const include = (id: string): void => {
        if (entries.has(id)) return;
        const pkg = JSON.parse(readFileSync(require.resolve(`${id}/package.json`), 'utf8'));
        const client = pkg.dsh.client;
        const row = { id, rev: 'pinned', url: `plugins/${id}/client.js?rev=pinned`,
            ...(client.inject ? { inject: client.inject } : {}), ...(client.external ? { external: client.external } : {}) };
        entries.set(id, row);
        for (const dependency of [...client.inject ?? [], ...client.external ?? []]) {
            if (dependency.startsWith('@deepseek-ai/dsh-')) include(dependency.replace(/\/client$/, ''));
        }
    };
    for (const id of [modules, 'hapi-dsh', account, models, cordisRunner, entryCustomization, '@deepseek-ai/dsh-client-ui-cordis',
        '@deepseek-ai/dsh-client-ui-model-selection', '@deepseek-ai/dsh-client-ui-attachment',
        '@deepseek-ai/dsh-client-ui-open-in-app', '@deepseek-ai/dsh-client-ui-sidebar-documentpreview']) include(id);
    return { rev: 'pinned', entries: [...entries.values()], batches: [
        { phase: 'bootstrap', url: 'plugins/bootstrap.js', rev: 'pinned', entries: [modules] },
        { phase: 'application', url: 'plugins/full.js', rev: 'pinned', entries: [...entries.keys()].filter(id => id !== modules) },
    ] };
}

test('pinned graph retains first-run onboarding, composer and live Cordis dispatch dependencies', () => {
    const full = officialGraph(), first = workspaceBootGraph(full);
    const kept = new Set(first.entries.map(row => row.id));
    assert.ok(!kept.has(account));
    assert.ok(kept.has('@deepseek-ai/dsh-client-ui-cordis'));
    for (const id of [models, cordisRunner, '@deepseek-ai/dsh-client-ui-model-selection',
        '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-conversation',
        '@deepseek-ai/dsh-client-ui-attachment', '@deepseek-ai/dsh-client-ui-trajectory',
        '@deepseek-ai/dsh-client-ui-open-in-app', '@deepseek-ai/dsh-client-ui-sidebar-documentpreview']) assert.ok(kept.has(id), id);
    const resumed = independentBootBatches(full);
    assert.equal(resumed.entries, full.entries);
    assert.ok(resumed.entries.some(row => row.id === models));
    assert.doesNotThrow(() => parseBootManifest(first));
    assert.doesNotThrow(() => parseBootManifest(resumed));
});

test('a plugin requiring the actual account settings slot keeps its official dependency in the first stage', () => {
    const full = officialGraph();
    full.entries.push({ id: 'fixture-account-settings-extension', rev: 'fixture', url: 'plugins/extension.js', inject: [account] });
    assert.ok(workspaceBootGraph(full).entries.some(row => row.id === account));
});

test('official More menus and locale providers are ready before conversation mounting', () => {
    const full = officialGraph(), first = workspaceBootGraph(full);
    for (const id of [entryCustomization, pluginManager]) {
        assert.ok(first.entries.some(row => row.id === id), `${id} is ready without waiting for account activation`);
    }
    assert.ok(!first.entries.some(row => row.id === account));
    assert.ok(!first.entries.some(row => row.id === hmr));
    assert.doesNotThrow(() => parseBootManifest(first));
});

test('an explicit first-stage consumer retains the official More menus and plugin manager together', () => {
    const full = officialGraph();
    full.entries.push({ id: 'fixture-entry-menu-extension', rev: 'fixture', url: 'plugins/entry-menu.js', inject: [entryCustomization] });
    const ids = new Set(workspaceBootGraph(full).entries.map(row => row.id));
    assert.ok(ids.has(entryCustomization));
    assert.ok(ids.has(pluginManager));
});

test('deferred stages retain original entries and add one optional closure before HMR', () => {
    const full = graph(), manager = '@deepseek-ai/dsh-client-product-analytics';
    full.entries.push({ id: manager, rev: 'manager-rev', url: 'plugins/manager.js' });
    const stages = deferredBootStages(full);
    assert.deepEqual(stages.map(stage => stage.entries.map(row => row.id)), [
        [modules, 'hapi-dsh', account],
        [modules, 'hapi-dsh', account, manager],
        [modules, 'hapi-dsh', account, hmr, manager],
    ]);
    let previous = workspaceBootGraph(full).entries;
    for (const stage of stages) {
        assert.equal(stage.rev, full.rev);
        assert.ok(previous.every(row => stage.entries.includes(row)));
        assert.ok(stage.entries.every(row => full.entries.includes(row)));
        assert.equal(stage.batches[0], full.batches[0]);
        assert.ok(stage.batches.filter(row => row.phase === 'application').every(row => row.entries.length === 1));
        assert.doesNotThrow(() => parseBootManifest(stage));
        previous = stage.entries;
    }
    assert.equal(stages.at(-1)!.entries, full.entries);
});

test('a deferred dependency cycle loads together and client subpath externals remain closed', () => {
    const full = graph(), manager = '@deepseek-ai/dsh-client-product-analytics';
    full.entries[2]!.external = [`${manager}/client`];
    full.entries.push({ id: manager, rev: 'manager-rev', url: 'plugins/manager.js', inject: [account] });
    const stages = deferredBootStages(full);
    assert.equal(stages.length, 2);
    assert.deepEqual(stages[0]!.entries.map(row => row.id), [modules, 'hapi-dsh', account, manager]);
    assert.equal(stages[1]!.entries, full.entries);
});

test('optional HMR consumers wait for the final graph without losing their dependency', () => {
    const full = graph(), manager = '@deepseek-ai/dsh-client-product-analytics';
    full.entries[2]!.inject = [hmr];
    full.entries.push({ id: manager, rev: 'manager-rev', url: 'plugins/manager.js' });
    const stages = deferredBootStages(full);
    assert.deepEqual(stages[0]!.entries.map(row => row.id), [modules, 'hapi-dsh', manager]);
    assert.equal(stages[1]!.entries, full.entries);
    full.entries[1]!.inject = [account];
    assert.ok(workspaceBootGraph(full).entries.some(row => row.id === hmr), 'required dependency closure takes priority');
    assert.ok(deferredBootStages(full).every(stage => stage.entries.some(row => row.id === hmr)));
});

test('an all-required refreshed graph still reconciles the current Host revision', () => {
    const full = graph();
    full.entries[1]!.inject = [account, hmr];
    full.rev = 'new-release';
    full.entries[1] = { ...full.entries[1]!, rev: 'new-entry', url: 'plugins/new-entry.js' };
    const stages = deferredBootStages(full);
    assert.equal(stages.length, 1);
    assert.equal(stages[0]!.entries, full.entries);
    assert.equal(stages[0]!.rev, 'new-release');
    assert.equal(stages[0]!.entries[1]!.rev, 'new-entry');
    assert.equal(stages[0]!.entries[1]!.url, 'plugins/new-entry.js');
});

test('every pinned deferred stage preserves first-run services and its complete installed dependency closure', () => {
    const full = officialGraph(), stages = deferredBootStages(full);
    const all = new Map(full.entries.map(row => [row.id, row]));
    const initial = workspaceBootGraph(full).entries;
    for (const stage of stages) {
        const ids = new Set(stage.entries.map(row => row.id));
        assert.ok(initial.every(row => stage.entries.includes(row)));
        assert.ok(ids.has(models));
        assert.ok(ids.has(cordisRunner));
        for (const row of stage.entries) for (const dependency of [...row.inject ?? [], ...row.external ?? []]) {
            const required = all.get(dependency) ?? all.get(dependency.replace(/\/client$/, ''));
            if (required) assert.ok(ids.has(required.id), `${row.id} requires ${required.id}`);
        }
        assert.doesNotThrow(() => parseBootManifest(stage));
    }
    assert.deepEqual(stages.at(-1)!.entries, full.entries);
});
