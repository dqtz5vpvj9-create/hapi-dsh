import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceMachineOptions } from '../src/hapi/source-machine-options.ts';

test('Pi creation choices keep provider identity and source unsupported thinking levels', async () => {
    const value = await sourceMachineOptions({ async request(path) {
        if (path.endsWith('/agent-availability')) return { agents: [{ agent: 'pi', available: true }] };
        assert.equal(path, '/api/machines/runner/pi-models');
        return { success: true, availableModels: [
            { provider: 'provider-a', modelId: 'same-name', thinkingLevelMap: { xhigh: null, off: 'none' } },
            { provider: 'provider-b', modelId: 'same-name', reasoning: false },
            { modelId: 'missing-provider' },
        ] };
    } }, { machineId: 'runner', agent: 'pi' });
    assert.deepEqual(value.models.map(row => row.id), ['provider-a/same-name', 'provider-b/same-name']);
    assert.ok(!value.models[0]!.reasoningEfforts.includes('xhigh'));
    assert.ok(value.models[0]!.reasoningEfforts.includes('off'));
    assert.deepEqual(value.models[1]!.reasoningEfforts, []);
    assert.match(value.warnings.join('\n'), /omitted the provider/);
});

test('OpenCode reads the original directory-specific catalog and each model’s exact variants', async () => {
    const calls: string[] = [];
    const value = await sourceMachineOptions({ async request(path) {
        calls.push(path);
        if (path.endsWith('/agent-availability')) return { agents: [{ agent: 'opencode', available: true }] };
        if (path.includes('/opencode-model-variants?')) return { success: true, variants: { 'p/a': ['minimal', 'careful'] } };
        return { success: true, availableModels: [{ modelId: 'p/a', name: 'A' }, { modelId: 'p/b' }] };
    } }, { machineId: 'runner', agent: 'opencode', cwd: '/repo with space' });
    assert.deepEqual(value.models.map(row => row.reasoningEfforts), [['minimal', 'careful'], []]);
    assert.ok(calls.every(path => !path.includes('codex')));
    for (const path of calls.filter(path => !path.endsWith('/agent-availability'))) assert.equal(new URL(path, 'http://fixture').searchParams.get('cwd'), '/repo with space');
});

test('source catalog failure is shown without inventing a model or available engine', async () => {
    const calls: string[] = [];
    const value = await sourceMachineOptions({ async request(path) {
        calls.push(path); throw new Error('Runner is offline');
    } }, { machineId: 'runner', agent: 'grok', cwd: '/repo' });
    assert.equal(value.availability.available, null);
    assert.deepEqual(value.models, []); assert.equal(value.warnings.length, 2);
    assert.deepEqual(calls, ['/api/machines/runner/agent-availability', '/api/machines/runner/grok-models?cwd=%2Frepo']);
});

test('Cursor keeps ACP rows and exact CLI SKU identities separate on the selected Runner', async () => {
    const paths: string[] = [];
    const value = await sourceMachineOptions({ async request(path) {
        paths.push(path);
        if (path.endsWith('/agent-availability')) return { agents: [{ agent: 'cursor', available: true }] };
        return { success: true, currentModelId: 'cursor-family-high-fast',
            availableModels: [{ modelId: 'family[reasoning=high,fast=false]', name: 'ACP family' }],
            cliModelSkus: [{ modelId: 'cursor-family-high-fast', name: 'Fast high' }, { modelId: 'cursor-family-high' }],
        };
    } }, { machineId: 'runner/b', agent: 'cursor', cwd: '/project' });
    assert.deepEqual(paths, ['/api/machines/runner%2Fb/agent-availability', '/api/machines/runner%2Fb/cursor-models']);
    assert.deepEqual(value.models.map(row => row.id), ['family[reasoning=high,fast=false]']);
    assert.deepEqual(value.cliModelSkus, [{ modelId: 'cursor-family-high-fast', name: 'Fast high' }, { modelId: 'cursor-family-high' }]);
    assert.equal(value.currentModelId, 'cursor-family-high-fast');
});

test('pre-session model support follows each launcher’s source contract', async () => {
    const calls: string[] = [];
    const client = { async request(path: string) { calls.push(path); return { agents: [{ agent: 'claude', available: false, reason: 'not_found' }] }; } };
    const claude = await sourceMachineOptions(client, { machineId: 'runner', agent: 'claude' });
    assert.equal(claude.availability.available, false);
    assert.ok(claude.models.every(row => row.origin === 'hapi-presets'));
    for (const agent of ['dsh', 'qoder', 'opencode'] as const) {
        const value = await sourceMachineOptions(client, { machineId: 'runner', agent });
        assert.deepEqual(value.models, []); assert.ok(value.warnings.length);
    }
    assert.ok(calls.every(path => path.endsWith('/agent-availability')));
});
