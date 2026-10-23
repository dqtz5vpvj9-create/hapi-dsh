import assert from 'node:assert/strict';
import test from 'node:test';
import { bootInjections } from '@deepseek-ai/dsh-client-modules';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createGraphModules } from '../src/client/graph-document.ts';
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules';
import { workspaceBootGraph, independentBootBatches, stageWorkspaceBoot } from '../src/shared/boot-graph.ts';

const { parseBootManifest } = createGraphModules({} as Document,
    readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-modules/client'), 'utf8'));

const modules = '@deepseek-ai/dsh-client-modules';
const account = '@deepseek-ai/dsh-client-ui-settings-account';
const hmr = '@deepseek-ai/dsh-client-hmr';
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
