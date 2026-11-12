/** Real pinned Typert gateway/policy and production adapter; native RPC is a read-only fixture. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import RemoteAccessService, { type RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access';
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '../src/remote/service.ts';
import type { CodexRpc } from '../src/remote/codex-rpc.ts';
import { SourceError } from '../src/remote/errors.ts';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import { SourceGateway } from '../src/remote/gateway.ts';
import { sourceSessionId } from '../src/remote/protocol.ts';
import { SourceNavigationService } from '../src/workspace/source-navigation-service.ts';
import { SOURCE_NAVIGATION_HOST_CONTRACT, type SourceResumeContext } from '../src/workspace/source-navigation-api.ts';
import { buildSourceResumeCommand } from '../src/client/source-resume-command.ts';

declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { 'resume-fixture': { kind: 'resume-fixture' } } }
const identity = { machineId: 'original-machine', sourceId: 'original-source', engine: 'codex', nativeId: '11111111-1111-4111-8111-111111111111' };
const sessionId = sourceSessionId(identity);

test('the original shared RPC supplies the exact store under source AND session grants, including revocation', async () => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-resume-context-'), ctx = new Context();
    const calls: Array<{ method: string; params: unknown }> = [];
    let paused: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
    const rpc = { online: true, currentGeneration: 1, onNotification: () => () => {}, onRequest: () => () => {}, onDisconnect: () => () => {}, dispose: async () => {},
        async connect() { if (paused) { paused.entered.resolve(); await paused.release.promise; } return { userAgent: 'fixture', codexHome: '/source/private-store', platformOs: 'linux', platformFamily: 'unix' }; },
        async request(method: string, params: unknown) { calls.push({ method, params }); assert.equal(method, 'thread/read');
            return { thread: { id: identity.nativeId, cwd: '/source/project', createdAt: 1, updatedAt: 2, status: { type: 'idle' } } }; },
    } as unknown as CodexRpc;
    const adapter = new DirectCodexAdapter({ ...identity, id: identity.sourceId, engine: 'codex' }, directory, { rpc, readMetadata: async () => { throw new SourceError('STALE_VERSION', 'The original metadata changed during this read.'); } });
    const source = new SourceGateway([adapter]);
    const lifetime = new AbortController();
    try {
        await ctx.plugin(TypertRegistry);
        const access = new RemoteAccessService(ctx), grants: RemoteAccessBinding[] = [];
        ctx.typert.resources.register('hhpiSource', { field: 'sourceId' });
        new SourceNavigationService(ctx, source);
        ctx.typert.register({ package: 'hapi-dsh', face: 'host', schemas: [], invocations: SOURCE_NAVIGATION_HOST_CONTRACT.invocations,
            model: { services: SOURCE_NAVIGATION_HOST_CONTRACT.services, events: [], objects: [] } });
        access.registerPolicy('resume-fixture', { bindings: () => grants });
        const carrier = new TypertGatewayService(ctx, TypertGatewayService.Config({}));
        const peer: PeerScope = { id: 'resume-fixture' as PeerId, ctx, principal: { kind: 'resume-fixture' }, interactions: 'answer', signal: lifetime.signal, async dispose() {} };
        const invoke = () => carrier.invoke({ peer, namespace: 'sourceNavigation', method: 'resumeContext', args: { request: { sessionId } } });
        await assert.rejects(invoke()); assert.equal(calls.length, 0);
        grants.push({ role: { name: 'Session resume', resource: 'session', actions: ['sourceNavigation/resumeContext'] }, resource: { kind: 'session', id: SessionId(sessionId) } });
        await assert.rejects(invoke()); assert.equal(calls.length, 0, 'a session grant must not reveal source-wide store metadata');
        grants.push({ role: { name: 'Source resume', resource: 'hhpiSource', actions: ['sourceNavigation/resumeContext'] }, resource: { kind: 'hhpiSource', id: identity.sourceId } });
        const result = await invoke() as SourceResumeContext;
        assert.deepEqual(result, { ...identity, sessionId, cwd: '/source/project', codexHome: '/source/private-store', platformOs: 'linux', platformFamily: 'unix' });
        assert.deepEqual(calls, [{ method: 'thread/read', params: { threadId: identity.nativeId, includeTurns: false } }]);
        await assert.rejects(source.resumeContext({ sessionId: sourceSessionId({ ...identity, machineId: 'foreign' }) }, () => true, lifetime.signal), { code: 'TARGET_UNAVAILABLE' });
        paused = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
        const pending = invoke(); await paused.entered.promise; grants.length = 0; paused.release.resolve();
        await assert.rejects(pending, 'grant revocation must prevent release of a late native store');
        assert.equal(calls.length, 1, 'copy never lists history, creates, resumes or sends');
        grants.push({ role: { name: 'Exact source position', resource: 'session', actions: ['sourceNavigation/locatePosition'] }, resource: { kind: 'session', id: SessionId(sessionId) } });
        await assert.rejects(carrier.invoke({ peer, namespace: 'sourceNavigation', method: 'locatePosition',
            args: { request: { sessionId, position: { turnId: 'original-turn' } } } }), (error: unknown) => {
                const value = error as { code?: string; message?: string; details?: { sourceCode?: string } };
                assert.equal(value.code, 'hhpi/source'); assert.equal(value.details?.sourceCode, 'STALE_VERSION');
                assert.equal(value.message, 'The original metadata changed during this read.'); return true;
            }, 'the real Typert invocation preserves the source failure instead of collapsing it to an internal error');
    } finally { lifetime.abort(); await source.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('source OS selects the shell and exact original home; unknown metadata never selects a default store', () => {
    const base = { engine: 'codex', nativeId: identity.nativeId, machineId: identity.machineId, machineName: null };
    const posix = buildSourceResumeCommand({ ...base, directory: "/project/it's here", codexHome: "/store/it's original", platformOs: 'linux', platformFamily: 'unix' });
    assert.equal(posix.available && posix.command, `cd '/project/it'"'"'s here' && env CODEX_HOME='/store/it'"'"'s original' codex resume '${identity.nativeId}'`);
    const windows = buildSourceResumeCommand({ ...base, directory: "D:\\project\\it's [literal]", codexHome: "C:\\Users\\it's me\\.codex", platformOs: 'windows', platformFamily: 'windows' });
    assert.equal(windows.available && windows.shell, 'powershell');
    assert.equal(windows.available && windows.command, `& { $ErrorActionPreference = 'Stop'; Set-Location -LiteralPath 'D:\\project\\it''s [literal]'; $env:CODEX_HOME = 'C:\\Users\\it''s me\\.codex'; codex resume '${identity.nativeId}' }`);
    assert.deepEqual(buildSourceResumeCommand({ ...base, directory: '/project', platformOs: 'linux', platformFamily: 'unix' }), { available: false, reason: 'missing-codex-home' });
    assert.deepEqual(buildSourceResumeCommand({ ...base, directory: '/project', codexHome: '/original', platformOs: 'unknown', platformFamily: 'unix' }), { available: false, reason: 'unsupported-platform' });
});
