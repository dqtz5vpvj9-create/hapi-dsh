/** Synthetic HAPI protocol, real pinned DSH Sessions, Agents, scopes and projection registries. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SessionStore from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import { CodexService } from '../src/codex/service.ts';
import { HapiAgentService } from '../src/hapi-agent/service.ts';
import type { HapiObservedTransport } from '../src/hapi-agent/agent.ts';
import { HapiRequestError, type HapiEvent, type HapiMessagesPage, type HapiSession } from '../src/codex/contracts.ts';
import { startSourceCatalogs } from '../src/hapi/catalog-startup.ts';
import { SourceSessionResolver } from '../src/hapi/source-session-resolver.ts';

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test('startup releases the Host after its budget and reports a genuine later catalog failure', async () => {
    const slow = deferred<void>(), failures: Array<{ source: string; error: unknown }> = [];
    const failure = new Error('Synthetic catalog transport disconnected');
    assert.equal(await startSourceCatalogs([{ name: 'slow source', start: () => slow.promise }], (source, error) => { failures.push({ source, error }); }, 1), 'background');
    assert.deepEqual(failures, []);
    slow.reject(failure);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(failures, [{ source: 'slow source', error: failure }]);
    assert.equal(await startSourceCatalogs([{ name: 'ready', start: async () => {} }], () => { assert.fail('unexpected failure'); }, 1_000), 'ready');
});

class CatalogFixture implements HapiObservedTransport {
    readonly hubId = 'catalog-fixture-hub';
    isConnected = true;
    readonly sources = new Map<string, HapiSession>();
    readonly details: string[] = [];
    readonly history: string[] = [];
    readonly slow = deferred<void>();
    readonly listeners = new Set<(event: HapiEvent) => void>();
    constructor() {
        for (let index = 0; index < 154; index++) {
            const native = index % 2 === 0, archived = index % 3 === 0, id = `synthetic-source-${index}`;
            this.sources.set(id, { id, namespace: 'fixture', seq: 1, createdAt: 1000 + index, updatedAt: 2000 + index,
                active: !archived, activeAt: 2000, thinking: false, thinkingAt: 2000, metadataVersion: 1, agentStateVersion: 1,
                metadata: { flavor: native ? 'codex' : 'claude', path: '/synthetic/project', machineId: 'synthetic-runner', host: 'Fixture', name: `Synthetic session ${index}`,
                    lifecycleState: archived ? 'archived' : 'running',
                    ...(native ? { codexNativeSession: true, codexSessionId: `synthetic-thread-${index}`, codexHome: '/synthetic/codex', codexNativeConnection: 'attached' }
                        : { claudeSessionId: `synthetic-thread-${index}` }) }, agentState: { requests: {}, completedRequests: {} } });
        }
    }
    async listSessions() {
        return [...this.sources.values()].map(value => {
            const source = structuredClone(value);
            if (source.metadata) delete source.metadata.codexNativeSession;
            return source;
        });
    }
    async getSession(id: string) {
        this.details.push(id);
        const source = this.sources.get(id);
        if (!source) throw new HapiRequestError('Synthetic source is missing', 'rejected', 404);
        return structuredClone(source);
    }
    async readMessages(id: string): Promise<HapiMessagesPage> {
        this.history.push(id);
        if (Number(id.slice('synthetic-source-'.length)) < 8) await this.slow.promise;
        return { messages: [], page: { direction: 'latest', limit: 200, epoch: 1, reset: false, nextBeforeSeq: null, nextBeforeAt: null,
            nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } };
    }
    async getQueuedState() { return { queuedLocalIds: [], invokedLocalMessages: [] }; }
    async sendMessage(): Promise<void> { assert.fail('Catalog reads must not send a message'); }
    async abortSession(): Promise<void> { assert.fail('Catalog reads must not stop execution'); }
    async approve(): Promise<void> { assert.fail('Catalog reads must not answer approvals'); }
    async deny(): Promise<void> { assert.fail('Catalog reads must not answer approvals'); }
    async cancelQueuedMessage(): Promise<never> { return assert.fail('Catalog reads must not cancel input'); }
    async steerQueuedMessage(): Promise<never> { return assert.fail('Catalog reads must not steer input'); }
    async retryIndeterminateMessage(): Promise<never> { return assert.fail('Catalog reads must not retry input'); }
    async listSlashCommands() { return []; }
    async request() { return { success: true, availableModels: [] }; }
    subscribe(listener: (event: HapiEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}

test('154 mixed sessions keep importing after startup while exact late native and archived sessions open immediately', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-large-catalog-')), fixture = new CatalogFixture(), ctx = new Context();
    let codex!: CodexService, observed!: HapiAgentService, completed: Promise<void> = Promise.resolve(), startup: string | undefined;
    const errors: string[] = [];
    try {
        await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(CommandRuntime);
        await ctx.plugin(Object.assign(async (owner: Context) => {
            codex = new CodexService(owner, fixture, { stateDirectory: join(directory, 'native'), onError: error => { errors.push(error.message); } });
            observed = new HapiAgentService(owner, fixture, { stateDirectory: join(directory, 'observed'), onError: error => { errors.push(error.message); } });
            const nativeStart = codex.start(), observedStart = observed.start();
            completed = Promise.all([nativeStart, observedStart]).then(() => {});
            startup = await startSourceCatalogs([{ name: 'native', start: () => nativeStart }, { name: 'observed', start: () => observedStart }],
                (_name, error) => { errors.push(String(error)); }, 10);
        }, { inject: ['sessions', 'agents', 'sessionProjections'] }));
        assert.equal(startup, 'background');
        assert.ok(codex.list().length + observed.list().length < 154);
        const resolver = new SourceSessionResolver(fixture, codex, observed);
        const native = await resolver.resolve({ hubId: fixture.hubId, sourceSessionId: 'synthetic-source-152' });
        const archived = await resolver.resolve({ hubId: fixture.hubId, sourceSessionId: 'synthetic-source-153' });
        assert.equal(native.sessionId, codex.byHapiSession('synthetic-source-152')?.id);
        assert.equal(archived.sessionId, observed.byHapiSession('synthetic-source-153')?.id);
        assert.equal(observed.byHapiSession('synthetic-source-153')?.sourceSession.metadata?.lifecycleState, 'archived');
        assert.ok(ctx.sessions.get(native.sessionId as never)); assert.ok(ctx.sessions.get(archived.sessionId as never));
        assert.equal(codex.byHapiSession('synthetic-source-0'), undefined, 'a slow earlier history is still pending');
        fixture.slow.resolve(); await completed;
        assert.equal(codex.list().length, 77); assert.equal(observed.list().length, 77);
        assert.equal(new Set([...codex.list(), ...observed.list()].map(agent => agent.binding.hapiSessionId)).size, 154, 'no source or archive cap');
        assert.deepEqual(errors, []);
        await assert.rejects(resolver.resolve({ hubId: fixture.hubId, sourceSessionId: 'synthetic-missing' }), /Synthetic source is missing/);
        assert.equal(codex.list().length + observed.list().length, 154, 'a missing original does not adopt another source');
    } finally {
        fixture.slow.resolve(); await completed.catch(() => {});
        await codex?.dispose(); await observed?.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true });
    }
});

test('disposing a Host during the first slow catalog batch stops later background attaches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-catalog-dispose-')), fixture = new CatalogFixture(), ctx = new Context(), errors: string[] = [];
    let codex!: CodexService, observed!: HapiAgentService;
    try {
        await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(CommandRuntime);
        await ctx.plugin(Object.assign(async (owner: Context) => {
            codex = new CodexService(owner, fixture, { stateDirectory: join(directory, 'native'), onError: error => { errors.push(error.message); } });
            observed = new HapiAgentService(owner, fixture, { stateDirectory: join(directory, 'observed'), onError: error => { errors.push(error.message); } });
            assert.equal(await startSourceCatalogs([{ name: 'native', start: () => codex.start() }, { name: 'observed', start: () => observed.start() }],
                (_source, error) => { errors.push(String(error)); }, 10), 'background');
        }, { inject: ['sessions', 'agents', 'sessionProjections'] }));
        const stopped = Promise.all([codex.dispose(), observed.dispose()]);
        fixture.slow.resolve(); await stopped;
        assert.equal(codex.list().length + observed.list().length, 0);
        assert.ok(fixture.details.every(id => Number(id.slice('synthetic-source-'.length)) < 8), 'shutdown never starts the remaining 146 source reads');
        assert.deepEqual(errors, []);
    } finally {
        fixture.slow.resolve(); await codex?.dispose(); await observed?.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true });
    }
});
