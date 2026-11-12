/** Real pinned Typert registry/Gateway/policy and production workspace composition; source FS is an explicit fixture. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import RemoteAccessService, { type RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access';
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway';
import { RemoteError, type PeerId, type PeerScope, type Principal } from '@deepseek-ai/dsh-typert-protocol';
import { TYPERT_REMOTE as FILES_REMOTE } from '@deepseek-ai/dsh-api-workspace-files/remote';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SourceGateway } from '../src/remote/gateway.ts';
import { SourceWorkspaceService, registerSourceWorkspaceContract } from '../src/remote/service.ts';
import { sourceSessionId, type SourceAdapter, type SourceSession } from '../src/remote/protocol.ts';
import { withWorkspaceService } from '../src/shared/source-access.ts';
import { createSourceWorkspaceProviders, type SourceWorkspaceOwner } from '../src/workspace/source-services.ts';
import { SOURCE_WORKSPACE_REMOTE, sourceWorkspaceInputs, sourceWorkspaceProxy, workspaceBindingSchema, type SourceWorkspaceApi, type SourceWorkspaceDescription } from '../src/workspace/source-api.ts';
import type { WorkspaceAccess, WorkspaceBinding, WorkspaceServices } from '../src/workspace/service-types.ts';

declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { 'workspace-service-fixture': { kind: 'workspace-service-fixture' } } }
const identity = { machineId: 'source-machine', sourceId: 'source-one', engine: 'codex', nativeId: 'thread-one' };
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'source', cwd: '/same/workspace', updatedAt: 1, status: 'idle', activeTurnId: null,
    capabilities: { send: false, steer: false, cancel: false, approve: false, files: false }, pendingRequests: [] };
const privateSession = { ...session, nativeId: 'private-thread', id: sourceSessionId({ ...identity, nativeId: 'private-thread' }) };
const data = new Uint8Array([0, 255, 128, 10]);
function services(binding: WorkspaceBinding): WorkspaceServices {
    const file = { absolutePath: `${binding.root}/note.bin`, bytes: data.length, version: 'opaque-source-version' };
    const inspect = async () => ({ ...file, name: 'note.bin', type: 'file' as const });
    return { binding, files: {
        async read() { return { ...file, offset: 1, text: binding.machineId, lines: 1, eof: true }; },
        async readBytes() { return { ...file, offset: 0, data, eof: true }; }, async stat() { return file; },
        async list() { return { path: '', entries: [{ name: 'note.bin', type: 'file', size: 4 }], truncated: false }; },
        async *changes() { yield { kind: 'ready' }; yield { kind: 'change', change: { absolutePath: file.absolutePath, version: file.version } }; },
    }, documents: {
        async open(document) { return { resource: { target: binding.target, document }, fileName: 'note.bin', mimeType: 'application/octet-stream', bytes: 4,
            version: file.version, writable: false, text: null }; },
        async bytes() { return { ...file, offset: 0, data, eof: true }; }, inspect, async search() { return [await inspect()]; },
        async git() { return { stdout: '', stderr: '', exitCode: 0 }; },
    } };
}
function nativeAdapter(sessions: SourceSession[]): SourceAdapter {
    const first = sessions[0]!;
    return { id: first.sourceId, machineId: first.machineId, engine: first.engine, async list() { return sessions; },
        async resolve(id) { const session = sessions.find(value => value.id === id); if (!session) throw new Error('Unknown native identity'); return session; },
        async read() { throw new Error('No transcript read is needed for workspace resolution'); }, async *changes() {},
        async operate() { throw new Error('Workspace composition cannot execute an Agent operation'); }, dispose() {} };
}
async function mount() {
    const ctx = new Context(); await ctx.plugin(TypertRegistry); const remoteAccess = new RemoteAccessService(ctx);
    const adapter = nativeAdapter([session, privateSession]);
    const gateway = new SourceGateway([adapter]), lifetime = new AbortController();
    const bindings: WorkspaceBinding[] = [], owners: SourceWorkspaceOwner[] = [];
    let create = (binding: WorkspaceBinding, _owner: SourceWorkspaceOwner): WorkspaceServices | Promise<WorkspaceServices> => services(binding);
    const unregister = gateway.registerWorkspace({ source: identity, workspaceId: 'source-os', pathStyle: 'posix', signal: lifetime.signal,
        create(binding, owner) { bindings.push(binding); owners.push(owner); return create(binding, owner); } });
    new SourceWorkspaceService(ctx, gateway, { localHostId: 'source-host', scopeId: '/source-installation' }); registerSourceWorkspaceContract(ctx);
    const carrier = new TypertGatewayService(ctx, TypertGatewayService.Config({})), grants: RemoteAccessBinding[] = [];
    remoteAccess.registerPolicy('workspace-service-fixture', { bindings: () => grants });
    const peerController = new AbortController();
    const peer = (principal: Principal): PeerScope => ({ id: 'workspace-service' as PeerId, ctx, principal, interactions: 'answer', signal: peerController.signal, async dispose() {} });
    const invoke = (method: string, args: Readonly<Record<string, unknown>>, principal: Principal = { kind: 'workspace-service-fixture' }) =>
        carrier.invoke({ peer: peer(principal), namespace: 'sourceWorkspace', method, args });
    const stream = (method: string, args: Readonly<Record<string, unknown>>, principal: Principal = { kind: 'workspace-service-fixture' }) =>
        carrier.stream({ peer: peer(principal), namespace: 'sourceWorkspace', method, args });
    return { ctx, gateway, adapter, grants, bindings, owners, unregister, peerController, invoke, stream,
        setCreate(value: typeof create) { create = value; },
        allow(methods: string[], id = session.id) { grants.push({ role: { name: 'Selected workspace', resource: 'session', actions: methods.map(method => `sourceWorkspace/${method}` as const) }, resource: { kind: 'session', id: SessionId(id) } }); },
        async close() { peerController.abort(); await gateway.dispose(); await ctx.fiber.dispose(); } };
}
const denied = (error: unknown) => error instanceof RemoteError && error.code === 'remote-access/denied';
const access = (controller = new AbortController()): WorkspaceAccess => ({ scope: 'account', signal: controller.signal, assertAllowed() {} });

test('source save/manage/receipt use exact resource grants and reject a caller-chosen Host before mutation', async () => {
    const app = await mount(); let saves = 0, manages = 0, observedTarget: unknown, observedBinding: unknown;
    const saved = { status: 'applied' as const, operationId: 'save-one', value: { absolutePath: '/same/workspace/note', version: 'new-version', bytes: 5 } };
    app.setCreate(binding => ({ ...services(binding), mutations: {
        async save(request) { saves++; observedTarget = request.target; observedBinding = binding.target; return saved; },
        async manage() { manages++; return { status: 'applied', operationId: 'manage-one', value: null }; },
        async receipt(id) { return id === saved.operationId ? saved : null; },
    } }));
    const request = { target: { hostId: 'source-host', sessionId: session.id }, operationId: 'save-one', path: 'note', baseline: { kind: 'absent' }, text: 'hello' };
    try {
        await assert.rejects(app.invoke('save', { request }), denied); assert.equal(saves, 0);
        app.allow(['save', 'manage', 'receipt']);
        await assert.rejects(app.invoke('save', { request: { ...request, target: { ...request.target, hostId: 'forged-central-host' } } }), denied);
        await assert.rejects(app.invoke('save', { request: { ...request, target: { ...request.target, sessionId: privateSession.id } } }), denied);
        assert.equal(saves, 0);
        assert.deepEqual(await app.invoke('save', { request }), saved);
        assert.deepEqual(observedTarget, request.target);
        assert.deepEqual(observedBinding, request.target);
        assert.deepEqual(await app.invoke('receipt', { request: { sessionId: session.id, operationId: 'save-one' } }), saved);
        assert.equal(await app.invoke('receipt', { request: { sessionId: session.id, operationId: 'missing' } }), null);
        const result = await app.invoke('manage', { request: { target: request.target, operationId: 'manage-one', operation: { action: 'create-file', path: 'new' } } });
        assert.deepEqual(result, { status: 'applied', operationId: 'manage-one', value: null }); assert.equal(manages, 1);
        assert.equal(sourceWorkspaceInputs.save.safeParse({ ...request, accountId: 'forged-account' }).success, false);
        assert.equal(sourceWorkspaceInputs.manage.safeParse({ target: request.target, operationId: 'one', root: '/central', operation: { action: 'create-file', path: 'new' } }).success, false);
        app.grants.length = 0; await assert.rejects(app.invoke('receipt', { request: { sessionId: session.id, operationId: 'save-one' } }), denied);
    } finally { await app.close(); }
});

test('source mutations without a registered provider fail without entering an Agent or serving-Host filesystem', async () => {
    const app = await mount();
    try {
        app.allow(['save']);
        await assert.rejects(app.invoke('save', { request: { target: { hostId: 'source-host', sessionId: session.id }, operationId: 'missing-provider',
            path: 'note', baseline: { kind: 'absent' }, text: 'never' } }), error => error instanceof RemoteError && error.code === 'workspace-service/unavailable');
        assert.equal(app.ctx.get('workspaceFiles'), undefined); assert.equal(app.ctx.get('agent'), undefined);
    } finally { await app.close(); }
});

test('the source workspace mutation proxy retains its original binding and only exposes actual registered mutations', async () => {
    const binding: WorkspaceBinding = { target: { hostId: 'source-host', sessionId: session.id }, machineId: identity.machineId, workspaceId: 'source', root: '/same/workspace', pathStyle: 'posix' };
    const description: SourceWorkspaceDescription = { binding, registered: { files: true, documents: true, mutations: true, uploads: false, terminals: false } };
    const calls: unknown[] = [], api = {
        async save(request: unknown) { calls.push(request); return { ok: true, value: { status: 'conflict', operationId: 'save-one', currentVersion: 'changed' } }; },
        async receipt(request: unknown) { calls.push(request); return { ok: true, value: null }; },
    } as unknown as SourceWorkspaceApi;
    const proxy = sourceWorkspaceProxy(api, description), request = { target: binding.target, operationId: 'save-one', path: 'note', baseline: { kind: 'absent' as const }, text: 'new' };
    assert.equal((await proxy.mutations!.save(request, access())).status, 'conflict');
    assert.equal(await proxy.mutations!.receipt('save-one', access()), null);
    assert.deepEqual(calls, [request, { sessionId: session.id, operationId: 'save-one' }]);
    await assert.rejects(proxy.mutations!.save({ ...request, target: { ...binding.target, hostId: 'another-host' } }, access()), /another source binding/);
    assert.equal(calls.length, 2);
    assert.equal(sourceWorkspaceProxy(api, { ...description, registered: { ...description.registered, mutations: false } }).mutations, undefined);
});

test('workspace services use current exact-session grants on the real Gateway without an Agent or Host Files service', async () => {
    const app = await mount();
    try {
        assert.equal(app.ctx.get('workspaceFiles'), undefined); assert.equal(app.ctx.get('agent'), undefined);
        await assert.rejects(app.invoke('read', { workspaceFileScopeId: session.id, path: 'note.bin', range: {} }), denied);
        assert.equal(app.bindings.length, 0);
        app.allow(['resolve', 'read', 'readBytes']);
        const description = await app.invoke('resolve', { request: { sessionId: session.id } }) as SourceWorkspaceDescription;
        assert.equal(workspaceBindingSchema.safeParse(description.binding).success, true);
        assert.equal(description.binding.machineId, identity.machineId); assert.equal(description.binding.root, session.cwd);
        assert.deepEqual(description.registered, { files: true, documents: true, mutations: false, uploads: false, terminals: false });
        assert.equal((await app.invoke('read', { workspaceFileScopeId: session.id, path: 'note.bin', range: {} }) as { text: string }).text, identity.machineId);
        const bytes = await app.invoke('readBytes', { workspaceFileScopeId: session.id, path: 'note.bin', options: {} }) as { data: Uint8Array };
        assert.deepEqual(bytes.data, data);
        assert.equal(new Set(app.owners.map(owner => owner.lifetimeId)).size, 1, 'repeated reads retain one source owner generation');
        assert.ok(app.owners[0]?.lifetimeId);
        await assert.rejects(app.invoke('read', { workspaceFileScopeId: privateSession.id, path: 'note.bin', range: {} }), denied);
        app.grants.length = 0;
        await assert.rejects(app.invoke('read', { workspaceFileScopeId: session.id, path: 'note.bin', range: {} }), denied);
    } finally { await app.close(); }
});

test('read response data is withheld when access is revoked during source IO', async () => {
    const app = await mount(), entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>();
    try {
        app.allow(['read']);
        app.setCreate(binding => { const value = services(binding); value.files.read = async () => { entered.resolve(); await reply.promise; return { absolutePath: '/same/workspace/note', version: 'v', offset: 1, text: 'private', lines: 1, eof: true }; }; return value; });
        const pending = app.invoke('read', { workspaceFileScopeId: session.id, path: 'note', range: {} });
        await entered.promise; app.grants.length = 0; reply.resolve();
        await assert.rejects(pending, denied);
    } finally { reply.resolve(); await app.close(); }
});

test('an open source watch checks current grants before releasing each later frame', async () => {
    const app = await mount();
    try {
        app.allow(['changes']);
        const iterator = (await app.stream('changes', { workspaceFileScopeId: session.id, path: 'note.bin' }))[Symbol.asyncIterator]();
        assert.deepEqual((await iterator.next()).value, { kind: 'ready' });
        app.grants.length = 0;
        await assert.rejects(iterator.next(), denied);
    } finally { await app.close(); }
});

test('the source proxy exposes official Files and DocumentPreview results through the same authenticated carrier', async () => {
    const app = await mount();
    try {
        app.allow(['resolve', 'read', 'readBytes', 'openDocument', 'readDocumentBytes']);
        const call = async (method: string, args: Record<string, unknown>) => ({ ok: true as const, value: await app.invoke(method, args) });
        // Only this client carrier object is a boundary adapter; the actual service/Gateway executes above.
        const api = {
            read: (sessionId: string, path: string, range: unknown) => call('read', { workspaceFileScopeId: sessionId, path, range }),
            readBytes: (sessionId: string, path: string, options: unknown) => call('readBytes', { workspaceFileScopeId: sessionId, path, options }),
            openDocument: (request: unknown) => call('openDocument', { request }),
            readDocumentBytes: (request: unknown) => call('readDocumentBytes', { request }),
        } as unknown as SourceWorkspaceApi;
        const description = await app.invoke('resolve', { request: { sessionId: session.id } }) as SourceWorkspaceDescription;
        const proxy = sourceWorkspaceProxy(api, description), current = access();
        assert.equal((await proxy.files.read('note.bin', {}, current)).text, identity.machineId);
        assert.deepEqual((await proxy.files.readBytes('note.bin', {}, current)).data, data);
        const document = await proxy.documents.open({ kind: 'file', path: 'note.bin' }, current);
        assert.deepEqual(document.resource.target, description.binding.target);
        assert.equal(document.mimeType, 'application/octet-stream');
        assert.deepEqual((await proxy.documents.bytes({ kind: 'file', path: 'note.bin' }, {}, current)).data, data);
    } finally { await app.close(); }
});

test('request cancellation stops resolution without terminating its source OS owner', async () => {
    const gateway = new SourceGateway([nativeAdapter([session])]), lifetime = new AbortController(), request = new AbortController();
    const entered = Promise.withResolvers<SourceWorkspaceOwner>(), reply = Promise.withResolvers<WorkspaceServices>();
    try {
        gateway.registerWorkspace({ source: identity, workspaceId: 'owner', pathStyle: 'posix', signal: lifetime.signal,
            create(binding, owner) { entered.resolve(owner); return reply.promise.then(value => ({ ...value, binding })); } });
        const pending = gateway.workspace({ hostId: 'source-host', sessionId: session.id }, () => true, access(request), 'read');
        const owner = await entered.promise; request.abort(); await assert.rejects(pending);
        assert.equal(owner.permissions, 'system-user'); assert.equal(owner.signal.aborted, false);
        reply.resolve(services({ target: { hostId: 'source-host', sessionId: session.id }, machineId: identity.machineId, workspaceId: 'unused', root: session.cwd, pathStyle: 'posix' }));
        await gateway.dispose(); assert.equal(owner.signal.aborted, true);
    } finally { await gateway.dispose(); }
});

test('source workspace registrations reject absent/wrong machines and never infer service availability from cwd', async () => {
    const gateway = new SourceGateway([nativeAdapter([session])]), lifetime = new AbortController();
    try {
        const target = { hostId: 'source-host', sessionId: session.id };
        await assert.rejects(gateway.workspace(target, () => true, access(), 'read'), /not registered/);
        assert.throws(() => gateway.registerWorkspace({ source: { ...identity, machineId: 'another-machine' }, workspaceId: 'owner', pathStyle: 'posix', signal: lifetime.signal, create: services }), /configured source/);
        gateway.registerWorkspace({ source: identity, workspaceId: 'owner', pathStyle: 'posix', signal: lifetime.signal,
            create: binding => ({ binding }) as WorkspaceServices });
        await assert.rejects(gateway.workspace(target, () => true, access(), 'read'), /not installed/);
    } finally { await gateway.dispose(); }
});

test('same file paths on two registered machines remain distinct and HHPI failures never enter ordinary providers', async () => {
    const second = { ...session, machineId: 'second-machine', sourceId: 'source-two', id: sourceSessionId({ ...identity, machineId: 'second-machine', sourceId: 'source-two' }) };
    const gateway = new SourceGateway([nativeAdapter([session]), nativeAdapter([second])]), lifetime = new AbortController();
    let ordinaryCalls = 0;
    try {
        for (const item of [session, second]) gateway.registerWorkspace({ source: item, workspaceId: 'owner', pathStyle: 'posix', signal: lifetime.signal, create: services });
        const providers = createSourceWorkspaceProviders({ localHostId: 'source-host', gateway, sourceAccess: () => true, action: 'read',
            async localDsh() { ordinaryCalls++; throw new Error('Unexpected ordinary Files fallback'); } });
        const read = (sessionId: string, hostId = 'source-host') => withWorkspaceService({ hostId, sessionId }, 'read', access(), providers,
            (value, call) => value.files.read('note.bin', {}, call));
        assert.equal((await read(session.id)).text, identity.machineId);
        assert.equal((await read(second.id)).text, second.machineId);
        await assert.rejects(read(sourceSessionId({ ...identity, machineId: 'unknown-machine' })));
        await assert.rejects(read('hhpi:malformed'));
        await assert.rejects(read(session.id, 'another-host'), /no workspace connection/);
        assert.equal(ordinaryCalls, 0);
    } finally { await gateway.dispose(); }
});

test('foreign roots/bindings and absent native cwd cannot become source workspaces', async () => {
    for (const wrong of ['root', 'target', 'relative-root'] as const) {
        const item = wrong === 'relative-root' ? { ...session, cwd: 'relative' } : session;
        const gateway = new SourceGateway([nativeAdapter([item])]), lifetime = new AbortController();
        try {
            gateway.registerWorkspace({ source: identity, workspaceId: 'owner', pathStyle: 'posix', signal: lifetime.signal, create(binding) {
                return services(wrong === 'root' ? { ...binding, root: '/central-host' } : { ...binding, target: { ...binding.target, hostId: 'foreign-host' } });
            } });
            await assert.rejects(gateway.workspace({ hostId: 'source-host', sessionId: item.id }, () => true, access(), 'read'), /different source|absolute workspace root/);
        } finally { await gateway.dispose(); }
    }
});

test('unregistering a source ends only its owner and prevents later service resolution', async () => {
    const app = await mount();
    try {
        app.allow(['resolve']); await app.invoke('resolve', { request: { sessionId: session.id } });
        const owner = app.owners[0]!; await app.unregister(); assert.equal(owner.signal.aborted, true);
        await assert.rejects(app.invoke('resolve', { request: { sessionId: session.id } }), /not registered/);
    } finally { await app.close(); }
});

test('source Files codecs retain official binary attachments while eliminating every default workspace lookup', () => {
    for (const descriptor of FILES_REMOTE.descriptors) {
        const source = SOURCE_WORKSPACE_REMOTE.descriptors.find(value => value.method === descriptor.method)!;
        assert.equal(source.result, descriptor.result); assert.equal(source.parameters[0]?.source, 'json');
        assert.equal(source.parameters[0]?.lookup, undefined);
    }
    const binary = SOURCE_WORKSPACE_REMOTE.descriptors.find(value => value.method === 'readBytes')!.result;
    assert.equal(binary.mode, 'strict'); if (binary.mode !== 'strict') return;
    const frames: Array<{ bytes: Uint8Array; path: readonly (string | number)[] }> = [];
    const result = { absolutePath: '/same/note.bin', bytes: 4, version: 'opaque', offset: 0, data, eof: true };
    const encoded = binary.encode!(result, (bytes, path) => { frames.push({ bytes, path }); return null; }) as { data: null };
    assert.equal(encoded.data, null); assert.deepEqual(frames, [{ bytes: data, path: ['data'] }]);
    assert.equal(sourceWorkspaceInputs.resolve.safeParse({ sessionId: session.id, root: '/central-host', machineId: 'central-host', authorized: true }).success, false);
});

test('upload receipt inputs resolve only on the original authorized session without requiring an OS workspace factory', async () => {
    const app = await mount(), calls: string[] = [];
    try {
        await app.unregister();
        Object.assign(app.adapter, { async uploadInputs(sessionId: string, receiptIds: readonly string[]) {
            calls.push(sessionId); assert.deepEqual(receiptIds, ['00000000-0000-4000-8000-000000000001']);
            return [{ type: 'localImage', path: '/source-owned/uploaded-image.png' }];
        } });
        const request = { sessionId: session.id, receiptIds: ['00000000-0000-4000-8000-000000000001'] };
        await assert.rejects(app.invoke('uploadInputs', { request }), denied);
        app.allow(['uploadInputs']);
        assert.deepEqual(await app.invoke('uploadInputs', { request }), { input: [{ type: 'localImage', path: '/source-owned/uploaded-image.png' }] });
        await assert.rejects(app.invoke('uploadInputs', { request: { ...request, sessionId: privateSession.id } }), denied);
        assert.equal(sourceWorkspaceInputs.uploadInputs.safeParse({ ...request, path: '/caller-guessed/file.png' }).success, false);
        assert.deepEqual(calls, [session.id]);
    } finally { await app.close(); }
});

test('upload receipt metadata returned after source access is revoked is withheld', async () => {
    const app = await mount(), entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>();
    try {
        Object.assign(app.adapter, { async uploadInputs() { entered.resolve(); await reply.promise; return [{ type: 'text', text: 'source file', text_elements: [] }]; } });
        app.allow(['uploadInputs']);
        const pending = app.invoke('uploadInputs', { request: { sessionId: session.id, receiptIds: ['00000000-0000-4000-8000-000000000001'] } });
        await entered.promise; app.grants.length = 0; reply.resolve();
        await assert.rejects(pending, denied);
    } finally { reply.resolve(); await app.close(); }
});
