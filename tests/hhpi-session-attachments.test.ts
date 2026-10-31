/** Real HHPI Session facade; only its authenticated resource wire and public scope boundary are fixtures. */
import assert from 'node:assert/strict';
import { before, test, type TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { HhpiRemoteApi } from '../src/hhpi-api.ts';
import type { RemoteSourceSession } from '../src/client/remote-sessions.ts';
import { RemoteSourceHistory } from '../src/client/remote-history.ts';
import { sourceSessionId, type SourcePage, type SourceResource, type SourceResourceRequest, type SourceSession } from '../src/remote/protocol.ts';

const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '..');
let Session: typeof RemoteSourceSession;
before(async () => {
    const output = await build({ entryPoints: [resolve(root, 'src/client/remote-sessions.ts')],
        alias: { '@deepseek-ai/dsh-api-session-controller/client': resolve(root, 'tests/fixtures/client-session-contract.ts') },
        external: ['@deepseek-ai/cordis'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent' });
    const module = { exports: {} as { RemoteSourceSession?: typeof RemoteSourceSession } };
    new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(require, module, module.exports);
    assert.ok(module.exports.RemoteSourceSession); Session = module.exports.RemoteSourceSession;
});
const attachment: ImageAttachmentRef = { attachmentId: AttachmentId('sha256:' + 'a'.repeat(64)), mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'synthetic.png' };
const resource = (): SourceResource => ({ encoding: 'base64', content: 'YWJj', mimeType: 'image/png', attachment });
async function fixture(t: TestContext, readResource: (request: SourceResourceRequest) => Promise<SourceResource>) {
    const identity = { machineId: 'synthetic-machine', sourceId: 'synthetic-source', engine: 'codex', nativeId: 'synthetic-thread' };
    const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic image', cwd: '/synthetic', updatedAt: 1,
        status: 'idle', activeTurnId: null, capabilities: { send: false, steer: false, cancel: false, approve: false, files: false }, pendingRequests: [] };
    const page: SourcePage = { session, epoch: 'epoch', version: 1, entries: [], before: null, after: null, hasBefore: false, hasAfter: false, context: [] };
    const history = new RemoteSourceHistory(session.id, { read: async () => page, async *changes() { throw new Error('No reader subscription is needed for a facade image read'); } });
    const requests: SourceResourceRequest[] = [];
    const api = { resource: async (request: SourceResourceRequest) => { requests.push(request); return { ok: true as const, value: await readResource(request) }; } } as HhpiRemoteApi;
    const face = new Session(session.id as SessionId, session, history, api);
    t.after(() => { face.dispose(); history.dispose(); });
    await face.ready;
    return { face, requests };
}

test('official image read resolves through the exact HHPI source session and returns decoded bytes', async t => {
    const f = await fixture(t, async () => resource());
    const result = await f.face.readAttachment(attachment.attachmentId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.attachment, attachment);
    assert.deepEqual([...result.value.data], [97, 98, 99]);
    assert.deepEqual(f.requests, [{ sessionId: f.face.sessionId, path: `attachment:${attachment.attachmentId}` }]);
});

test('a mismatched image identity or malformed source bytes never enters the official image cache', async t => {
    let value = { ...resource(), attachment: { ...attachment, attachmentId: AttachmentId('sha256:' + 'b'.repeat(64)) } };
    const f = await fixture(t, async () => value);
    assert.equal((await f.face.readAttachment(attachment.attachmentId)).ok, false);
    value = { ...resource(), attachment, content: 'YQ==' };
    assert.equal((await f.face.readAttachment(attachment.attachmentId)).ok, false, 'truncated source bytes must fail durable reference length validation');
});

test('releasing a Session while its image is loading rejects the late response and future image reads', async t => {
    const gate = Promise.withResolvers<SourceResource>();
    const f = await fixture(t, async () => gate.promise);
    const pending = f.face.readAttachment(attachment.attachmentId);
    f.face.dispose(); gate.resolve(resource());
    assert.equal((await pending).ok, false);
    assert.equal((await f.face.readAttachment(attachment.attachmentId)).ok, false);
    assert.equal(f.requests.length, 1, 'released source views cannot dispatch another resource read');
});
