/** Production source file owner and pinned official Files over isolated, real OS directories. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-api-remote-access/types';
import { LocalSourceFileOwner } from '../src/workspace/source-files.ts';
import type { WorkspaceAccess, WorkspaceBinding } from '../src/workspace/service-types.ts';

async function fixture(options: Partial<ConstructorParameters<typeof LocalSourceFileOwner>[0]> = {}) {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-source-files-');
    const root = join(directory, 'source'), database = join(directory, 'private', 'receipts.sqlite'); await mkdir(root);
    const lifetime = new AbortController();
    const binding: WorkspaceBinding = { target: { hostId: 'source-host', sessionId: 'exact-native-session' }, machineId: 'source-machine',
        workspaceId: 'configured-source-workspace', root, pathStyle: 'posix' };
    let owner = new LocalSourceFileOwner({ database, signal: lifetime.signal, ...options });
    let services = owner.workspace(binding);
    const access: WorkspaceAccess = { scope: 'account-one', signal: new AbortController().signal, assertAllowed() {} };
    return { directory, root, binding, access, get services() { return services; },
        async restart() { await owner.close(); owner = new LocalSourceFileOwner({ database, signal: lifetime.signal, ...options }); services = owner.workspace(binding); },
        async close() { lifetime.abort(); await owner.close(); await rm(directory, { recursive: true, force: true }); } };
}
const denied = () => new RemoteError('remote-access/denied', 'Revoked', { action: 'sourceWorkspace/save', reason: 'no-allow' });

test('source reads, byte windows, directories and watch reuse real pinned official Files without an Agent', async () => {
    const app = await fixture();
    try {
        await writeFile(join(app.root, 'note.txt'), 'one\n二\nthree\n'); await writeFile(join(app.root, 'binary.bin'), new Uint8Array([0, 255, 128, 10]));
        const page = await app.services.files.read('note.txt', { offset: 2, limit: 1 }, app.access);
        assert.equal(page.text, '二'); assert.equal(page.offset, 2); assert.equal(page.lines, 1); assert.equal(page.eof, false);
        const bytes = await app.services.files.readBytes('binary.bin', { range: { offset: 1, length: 2 } }, app.access);
        assert.deepEqual([...bytes.data], [255, 128]); assert.equal(bytes.eof, false);
        const listing = await app.services.files.list('.', app.access); assert.deepEqual(listing.entries.map(entry => entry.name), ['binary.bin', 'note.txt']);
        const controller = new AbortController(), watching = app.services.files.changes('note.txt', { ...app.access, signal: controller.signal });
        const iterator = watching[Symbol.asyncIterator](); assert.deepEqual((await iterator.next()).value, { kind: 'ready' }); controller.abort();
        await iterator.return?.();
        const outside = join(app.directory, 'outside.txt'); await writeFile(outside, 'outside source workspace');
        assert.equal((await app.services.files.read(outside, {}, app.access)).text, 'outside source workspace');
        await assert.rejects(app.services.files.list(app.directory, app.access), error => error instanceof RemoteError && error.code === 'workspace-file/outside-workspace');
    } finally { await app.close(); }
});

test('documents preserve UTF-8 BOM/CRLF, binary original bytes, source identity, search and read-only Git', async () => {
    const app = await fixture();
    try {
        await writeFile(join(app.root, 'note.md'), '\uFEFF第一行\r\nsecond\r\n'); await writeFile(join(app.root, 'image.png'), new Uint8Array([137, 80, 78, 71]));
        const doc = await app.services.documents.open({ kind: 'file', path: 'note.md' }, app.access);
        assert.deepEqual(doc.resource.target, app.binding.target); assert.equal(doc.text, '第一行\nsecond\n'); assert.equal(doc.writable, true);
        assert.deepEqual(doc.format, { bom: true, eol: '\r\n' });
        assert.equal((await app.services.documents.open({ kind: 'file', path: 'image.png' }, app.access)).text, null);
        assert.deepEqual([...(await app.services.documents.bytes({ kind: 'file', path: 'image.png' }, {}, app.access)).data], [137, 80, 78, 71]);
        assert.deepEqual((await app.services.documents.search('note', 10, app.access)).map(value => value.name), ['note.md']);
        const git = await app.services.documents.git({ kind: 'status' }, app.access); assert.notEqual(git.exitCode, 0);
        await assert.rejects(app.services.documents.open({ kind: 'artifact', id: 'unregistered' }, app.access), /registered artifact provider/);
    } finally { await app.close(); }
});

test('save publishes real source bytes, preserves format and mode, then rejects an external edit and stale concurrent view', async () => {
    const app = await fixture();
    try {
        const path = join(app.root, 'note.txt'); await writeFile(path, 'old', { mode: 0o640 });
        const baseline = await app.services.files.stat('note.txt', app.access);
        const request = { target: app.binding.target, operationId: 'save-one', path: 'note.txt', baseline: { kind: 'version' as const, version: baseline.version },
            text: 'new\n内容\n', format: { bom: true, eol: '\r\n' as const } };
        const result = await app.services.mutations!.save(request, app.access);
        assert.equal(result.status, 'applied'); assert.equal(await readFile(path, 'utf8'), '\uFEFFnew\r\n内容\r\n'); assert.equal((await stat(path)).mode & 0o777, 0o640);
        await writeFile(path, 'external process');
        const conflict = await app.services.mutations!.save({ ...request, operationId: 'save-two', text: 'stale view' }, app.access);
        assert.equal(conflict.status, 'conflict'); assert.equal(await readFile(path, 'utf8'), 'external process');
        const current = await app.services.files.stat('note.txt', app.access), next = { ...request, baseline: { kind: 'version' as const, version: current.version } };
        const pair = await Promise.all([app.services.mutations!.save({ ...next, operationId: 'concurrent-a', text: 'A' }, app.access),
            app.services.mutations!.save({ ...next, operationId: 'concurrent-b', text: 'B' }, app.access)]);
        assert.deepEqual(pair.map(value => value.status), ['applied', 'conflict']); assert.equal(await readFile(path, 'utf8'), '\uFEFFA');
    } finally { await app.close(); }
});

test('durable operation receipts prevent replay after acknowledgement loss, restart and identity reuse', async () => {
    const app = await fixture();
    try {
        const request = { target: app.binding.target, operationId: 'create-once', path: 'created.txt', baseline: { kind: 'absent' as const }, text: 'original' };
        const first = await app.services.mutations!.save(request, app.access); assert.equal(first.status, 'applied');
        await writeFile(join(app.root, 'created.txt'), 'edited after acknowledgement loss');
        assert.deepEqual(await app.services.mutations!.save(request, app.access), first);
        await app.restart(); assert.deepEqual(await app.services.mutations!.receipt(request.operationId, app.access), first);
        assert.deepEqual(await app.services.mutations!.save(request, app.access), first);
        assert.equal(await readFile(join(app.root, 'created.txt'), 'utf8'), 'edited after acknowledgement loss');
        await assert.rejects(app.services.mutations!.save({ ...request, text: 'reused operation' }, app.access), /different arguments/);
        assert.equal(await app.services.mutations!.receipt(request.operationId, { ...app.access, scope: 'other-account' }), null);
    } finally { await app.close(); }
});

test('revocation at the save publication checkpoint leaves the source unchanged and a rejected receipt', async () => {
    const app = await fixture();
    try {
        await writeFile(join(app.root, 'note.txt'), 'unchanged'); const baseline = await app.services.files.stat('note.txt', app.access); let checks = 0;
        const access: WorkspaceAccess = { ...app.access, assertAllowed(_target, action) { if (action === 'save' && ++checks >= 2) throw new Error('This fixture account lost its current grant'); } };
        await assert.rejects(app.services.mutations!.save({ target: app.binding.target, operationId: 'revoked-before-publish', path: 'note.txt',
            baseline: { kind: 'version', version: baseline.version }, text: 'must not publish' }, access), deniedError => deniedError instanceof RemoteError);
        assert.equal(await readFile(join(app.root, 'note.txt'), 'utf8'), 'unchanged');
        const receipt = await app.services.mutations!.receipt('revoked-before-publish', app.access); assert.equal(receipt?.status, 'rejected');
        assert.deepEqual((await app.services.files.list('.', app.access)).entries.map(entry => entry.name), ['note.txt']);
    } finally { await app.close(); }
});

test('a committed save whose caller loses authorization is reconciled by the original receipt without repeating it', async () => {
    const app = await fixture();
    try {
        let checks = 0; const access: WorkspaceAccess = { ...app.access, assertAllowed(_target, action) { if (action === 'save' && ++checks >= 3) throw denied(); } };
        const request = { target: app.binding.target, operationId: 'committed-reply-lost', path: 'note.txt', baseline: { kind: 'absent' as const }, text: 'committed' };
        await assert.rejects(app.services.mutations!.save(request, access), error => error instanceof RemoteError);
        assert.equal(await readFile(join(app.root, 'note.txt'), 'utf8'), 'committed');
        assert.equal((await app.services.mutations!.receipt(request.operationId, app.access))?.status, 'applied');
        await writeFile(join(app.root, 'note.txt'), 'later edit'); await app.services.mutations!.save(request, app.access);
        assert.equal(await readFile(join(app.root, 'note.txt'), 'utf8'), 'later edit');
    } finally { await app.close(); }
});

test('real file and directory creation, binary copy, rename, move and explicit recursive delete keep destinations intact', async () => {
    const app = await fixture(); let operation = 0;
    const manage = (value: Parameters<NonNullable<typeof app.services.mutations>['manage']>[0]['operation']) => app.services.mutations!.manage({ target: app.binding.target, operationId: `manage-${++operation}`, operation: value }, app.access);
    try {
        assert.equal((await manage({ action: 'create-directory', path: 'dir' })).status, 'applied');
        assert.equal((await manage({ action: 'create-file', path: 'dir/empty' })).status, 'applied');
        const bytes = new Uint8Array([0, 255, 128, 10]); await writeFile(join(app.root, 'dir', 'binary'), bytes);
        const source = await app.services.documents.inspect('dir/binary', app.access); assert.ok(source);
        assert.equal((await manage({ action: 'copy', path: 'dir/binary', destination: 'copy', expectedVersion: source.version })).status, 'applied');
        assert.deepEqual(await readFile(join(app.root, 'copy')), Buffer.from(bytes));
        assert.equal((await manage({ action: 'rename', path: 'dir/binary', destination: 'copy', expectedVersion: source.version })).status, 'conflict');
        assert.deepEqual(await readFile(join(app.root, 'dir', 'binary')), Buffer.from(bytes));
        assert.equal((await manage({ action: 'rename', path: 'dir/binary', destination: 'renamed', expectedVersion: source.version })).status, 'applied');
        const dir = await app.services.documents.inspect('dir', app.access); assert.ok(dir);
        assert.equal((await manage({ action: 'move', path: 'dir', destination: 'moved-dir', expectedVersion: dir.version })).status, 'applied');
        assert.equal(await readFile(join(app.root, 'moved-dir', 'empty'), 'utf8'), '');
        const moved = await app.services.documents.inspect('moved-dir', app.access); assert.ok(moved);
        assert.equal((await manage({ action: 'delete', path: 'moved-dir', expectedVersion: moved.version, recursive: true })).status, 'applied');
        assert.equal(await app.services.documents.inspect('moved-dir', app.access), null);
    } finally { await app.close(); }
});

test('workspace root, foreign targets, traversal and symlink escapes cannot become write targets', async () => {
    const app = await fixture();
    try {
        await writeFile(join(app.directory, 'outside'), 'private'); await symlink(app.directory, join(app.root, 'escape'));
        for (const path of ['../outside', 'escape/outside']) {
            const result = await app.services.mutations!.save({ target: app.binding.target, operationId: `escape-${path}`, path,
                baseline: { kind: 'absent' }, text: 'never' }, app.access); assert.equal(result.status, 'rejected');
        }
        const result = await app.services.mutations!.manage({ target: app.binding.target, operationId: 'delete-root',
            operation: { action: 'delete', path: '.', expectedVersion: 'any', recursive: true } }, app.access); assert.equal(result.status, 'rejected');
        await assert.rejects(app.services.mutations!.save({ target: { ...app.binding.target, hostId: 'foreign-host' }, operationId: 'foreign', path: 'safe',
            baseline: { kind: 'absent' }, text: 'never' }, app.access), /another source session/);
        assert.equal(await readFile(join(app.directory, 'outside'), 'utf8'), 'private');
    } finally { await app.close(); }
});

test('source copy failure retains an indeterminate receipt and never replays a partially applied directory operation', async () => {
    const app = await fixture({ maxCopyBytes: 1 });
    try {
        await mkdir(join(app.root, 'dir')); await writeFile(join(app.root, 'dir', 'file'), 'larger than bound');
        const source = await app.services.documents.inspect('dir', app.access); assert.ok(source);
        const request = { target: app.binding.target, operationId: 'partial-copy', operation: { action: 'copy' as const, path: 'dir', destination: 'partial', expectedVersion: source.version } };
        const result = await app.services.mutations!.manage(request, app.access); assert.equal(result.status, 'indeterminate');
        await app.restart(); assert.deepEqual(await app.services.mutations!.manage(request, app.access), result);
        assert.equal(await readFile(join(app.root, 'dir', 'file'), 'utf8'), 'larger than bound');
        assert.equal(await app.services.documents.inspect('partial/file', app.access), null);
    } finally { await app.close(); }
});

test('cancelled source views release reads while the file owner remains usable until explicit close', async () => {
    const app = await fixture();
    try {
        await writeFile(join(app.root, 'note'), 'still here'); const controller = new AbortController(); controller.abort();
        await assert.rejects(app.services.files.read('note', {}, { ...app.access, signal: controller.signal }), { name: 'AbortError' });
        assert.equal((await app.services.files.read('note', {}, app.access)).text, 'still here');
    } finally { await app.close(); }
});
