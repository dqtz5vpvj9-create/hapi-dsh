/** Synthetic frozen exports only; no Hub, production database or execution owner is opened. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ExactIdentityIndex, RecoveryPackage, SnapshotReader, hubSessionNativeIdentity, runOfflineMigration, resumeOfflineRecovery, type OfflineRequest, type OfflineStage } from '../scripts/migrations/hapi-offline/index.ts'
import { sourceSessionId } from '../src/remote/protocol.ts'
import type { AppSourceRoute } from '../src/workspace/app-service-types.ts'

async function fixture(t: test.TestContext, requiredStages: OfflineRequest['requiredStages'] = []) {
    const root = await mkdtemp('/mnt/cache/data-cache/hhpi-offline-test-')
    t.after(() => rm(root, { recursive: true, force: true }))
    const snapshot = join(root, 'snapshot'), output = join(root, 'recovery')
    await mkdir(snapshot)
    await writeFile(join(snapshot, 'session.json'), JSON.stringify({ id: 'old-session', metadata: { flavor: 'codex', machineId: 'machine-a', codexSessionId: 'native-a' }, draft: '未发送草稿', receipt: { operationId: 'original-operation', state: 'unknown' } }))
    await writeFile(join(snapshot, 'events.jsonl'), '{"seq":8,"text":"正文"}\ninvalid-json-line\n')
    await writeFile(join(snapshot, 'attachment.bin'), Buffer.from([0, 255, 10, 1]))
    const db = new DatabaseSync(join(snapshot, 'hub-backup.sqlite'))
    db.exec('PRAGMA user_version=33; CREATE TABLE sessions(id TEXT PRIMARY KEY,namespace TEXT,metadata TEXT);')
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('old-session', 'old-namespace', '{"machineId":"machine-a","flavor":"codex","codexSessionId":"native-a"}')
    db.close()
    const request: OfflineRequest = { version: 1, packageId: 'synthetic-private-package', scope: 'account-generation-a', snapshot: { id: 'selected-snapshot', root: snapshot, inputs: [
        { id: 'session', path: 'session.json', format: 'json', version: 'hub-export-v1' },
        { id: 'events', path: 'events.jsonl', format: 'jsonl', version: 'hub-events-v1' },
        { id: 'attachment', path: 'attachment.bin', format: 'binary', version: 'bytes-v1' },
        { id: 'hub', path: 'hub-backup.sqlite', format: 'sqlite-backup', version: 'sqlite-user-version-33' },
    ] }, requiredStages }
    return { root, snapshot, output, request }
}
function target(sourceId = 'source-a', hostId = 'host-a'): AppSourceRoute {
    const identity = { machineId: 'machine-a', sourceId, engine: 'codex', nativeId: 'native-a' }
    return { kind: 'hhpi', hostId, sessionId: sourceSessionId(identity), identity }
}

test('capture retains every selected byte, malformed JSONL and unknown receipts without a source operation', async t => {
    const f = await fixture(t), first = await runOfflineMigration(f.request, f.output)
    assert.equal(first.status, 'preserved'); assert.equal(first.objects.length, 0)
    for (const input of first.inputs) assert.deepEqual(await readFile(join(f.output, input.file)), await readFile(join(f.snapshot, input.originalPath)))
    const archive = await RecoveryPackage.open(f.output)
    try {
        const snapshot = await archive.snapshot(), lines = []
        for await (const line of snapshot.jsonLines('events')) lines.push(line)
        assert.equal(lines[1]!.raw, 'invalid-json-line'); assert.ok(lines[1]!.error)
        const session = await snapshot.json('session') as { receipt: { operationId: string; state: string }; draft: string }
        assert.deepEqual(session.receipt, { operationId: 'original-operation', state: 'unknown' }); assert.equal(session.draft, '未发送草稿')
        await snapshot.sqlite('hub', async db => {
            await Promise.resolve()
            assert.equal(db.schema().userVersion, 33)
            assert.equal([...db.rows('SELECT * FROM sessions WHERE namespace=?', ['old-namespace'])][0]!.id, 'old-session')
            assert.throws(() => [...db.rows('DELETE FROM sessions')], /reads/)
            assert.throws(() => [...db.rows('WITH selected AS (SELECT 1) DELETE FROM sessions')], /readonly|read-only/)
        })
    } finally { archive.close() }
    assert.equal((await stat(f.output)).mode & 0o777, 0o700)
    assert.equal((await stat(join(f.output, 'recovery.sqlite'))).mode & 0o777, 0o600)
    assert.deepEqual(await runOfflineMigration(f.request, f.output), first, 'repeat capture reuses the same package and object identities')
})

test('failed conversion resumes from the archived bytes after original exports disappear, without duplicating objects', async t => {
    const f = await fixture(t, [{ id: 'sessions', version: '1' }]); let attempts = 0
    const stage: OfflineStage = { id: 'sessions', version: '1', async run({ snapshot, recovery }) {
        const value = await snapshot.json('session')
        await recovery.putObject({ id: 'hub-a:namespace-a:old-session', family: 'sessions', inputId: 'session', state: 'unresolved', value, reason: 'Exact machine/native target is unavailable.' })
        if (++attempts === 1) throw new Error('Synthetic interruption after a durable object')
    } }
    await assert.rejects(runOfflineMigration(f.request, f.output, [stage]), /Synthetic interruption/)
    const failed = JSON.parse(await readFile(join(f.output, 'index.json'), 'utf8'))
    assert.equal(failed.status, 'incomplete'); assert.equal(failed.objects.length, 1); assert.equal(failed.stages[0].state, 'failed')
    await rename(f.snapshot, join(f.root, 'original-moved'))
    const complete = await runOfflineMigration(f.request, f.output, [stage])
    assert.equal(complete.status, 'needs-review'); assert.equal(complete.unresolved, 1); assert.equal(complete.objects.length, 1)
    assert.equal(JSON.parse(await readFile(join(f.output, complete.objects[0]!.file), 'utf8')).value.draft, '未发送草稿')
    await runOfflineMigration(f.request, f.output, [stage]); assert.equal(attempts, 2, 'a complete stage is not re-executed on repetition')
})

test('journal payload recovers an interrupted materialization and rejects reuse of an original object key', async t => {
    const f = await fixture(t), recovery = await RecoveryPackage.open(f.output, f.request)
    await recovery.capture(await SnapshotReader.open(f.snapshot, f.request.snapshot.inputs))
    const input = { id: 'old-draft', family: 'application' as const, inputId: 'session', state: 'preserved' as const, value: { draft: '<script>private</script>' } }
    await recovery.putObject(input)
    await assert.rejects(recovery.putObject({ ...input, value: 'replacement' }), /reused with different content/)
    recovery.close()
    const journal = new DatabaseSync(join(f.output, 'recovery.sqlite'))
    journal.prepare('UPDATE objects SET materialized=0').run(); journal.close()
    await rm(join(f.output, 'objects', '1.json'))
    const index = await resumeOfflineRecovery(f.output)
    assert.deepEqual(JSON.parse(await readFile(join(f.output, index.objects[0]!.file), 'utf8')).value, input.value)
    await assert.rejects(RecoveryPackage.open(f.output, { ...f.request, scope: 'other-account' }), /another snapshot/)
})

test('a completed raw-copy rename recovers when the complete journal update was interrupted', async t => {
    const f = await fixture(t), recovery = await RecoveryPackage.open(f.output, f.request)
    await recovery.capture(await SnapshotReader.open(f.snapshot, f.request.snapshot.inputs)); recovery.close()
    const journal = new DatabaseSync(join(f.output, 'recovery.sqlite'))
    journal.prepare("UPDATE inputs SET state='pending' WHERE id='session'").run(); journal.close()
    await rename(f.snapshot, join(f.root, 'source-moved'))
    const index = await runOfflineMigration(f.request, f.output)
    assert.equal(index.status, 'preserved'); assert.equal(index.inputs.length, f.request.snapshot.inputs.length)
    const input = index.inputs.find(value => value.id === 'session')!
    assert.equal(JSON.parse(await readFile(join(f.output, input.file), 'utf8')).draft, '未发送草稿')
})

test('exact identity never guesses from title, cwd, a revision suffix or an engine default', () => {
    const session = { id: 'old', title: 'Shared title', cwd: '/same', metadata: { flavor: 'codex', machineId: 'machine-a', codexSessionId: 'native-a' } }
    const identity = hubSessionNativeIdentity(session)!
    const first = target(), index = new ExactIdentityIndex([{ identity, target: first }])
    assert.deepEqual(index.match(identity), { status: 'matched', target: first })
    assert.equal(index.match({ ...identity, nativeId: 'native-a-r2' }).status, 'unmapped')
    assert.equal(index.match({ ...identity, machineId: 'other-machine' }).status, 'unmapped')
    assert.equal(hubSessionNativeIdentity({ ...session, metadata: { ...session.metadata, flavor: undefined } }), null)
    assert.equal(hubSessionNativeIdentity({ ...session, metadata: { flavor: 'codex', machineId: 'machine-a', title: 'native-a', cwd: '/same' } }), null)
    assert.equal(hubSessionNativeIdentity({ ...session, machine_id: 'conflicting-machine' }), null)
    assert.deepEqual(hubSessionNativeIdentity({ machine_id: 'machine-a', metadata: JSON.stringify({ flavor: 'codex', codexSessionId: 'native-a' }) }), identity)
    const second = target('source-b'), ambiguous = new ExactIdentityIndex([{ identity, target: first }, { identity, target: second }])
    assert.equal(ambiguous.match(identity).status, 'ambiguous')
    assert.deepEqual(ambiguous.match({ ...identity, sourceId: 'source-b' }), { status: 'matched', target: second })
    assert.throws(() => new ExactIdentityIndex([{ identity: { ...identity, nativeId: 'wrong' }, target: first }]), /does not match/)
})

test('unresolved object IDs remain accessible without being interpreted as file paths or executable HTML', async t => {
    const f = await fixture(t), recovery = await RecoveryPackage.open(f.output, f.request)
    try {
        await recovery.capture(await SnapshotReader.open(f.snapshot, f.request.snapshot.inputs))
        await recovery.putObject({ id: '../../<script>lost</script>', family: 'files', inputId: 'attachment', state: 'unresolved', reason: '<img src=x onerror=alert(1)>', value: { originalPath: '/source/path', state: 'conflict', savedBase: 'base', userDraft: 'draft' } })
        const index = await recovery.resume(), page = await readFile(join(f.output, 'index.html'), 'utf8')
        assert.equal(index.objects[0]!.file, 'objects/1.json')
        assert.ok(page.includes('&lt;script&gt;lost&lt;/script&gt;')); assert.ok(!page.includes('<img src=x'))
        assert.equal(JSON.parse(await readFile(join(f.output, index.objects[0]!.file), 'utf8')).value.userDraft, 'draft')
    } finally { recovery.close() }
})

test('snapshot selection rejects escaping paths, symlinks and live WAL databases, preserving original files', async t => {
    const f = await fixture(t), input = f.request.snapshot.inputs[0]!
    await assert.rejects(SnapshotReader.open(f.snapshot, [{ ...input, path: '../outside.json' }]), /escapes/)
    await symlink(join(f.snapshot, 'session.json'), join(f.snapshot, 'linked.json'))
    await assert.rejects(SnapshotReader.open(f.snapshot, [{ ...input, path: 'linked.json' }]), /symbolic links/)
    await writeFile(join(f.snapshot, 'hub-backup.sqlite-wal'), 'not-a-frozen-backup')
    await assert.rejects(SnapshotReader.open(f.snapshot, f.request.snapshot.inputs), /consistent SQLite backup/)
    assert.equal(JSON.parse(await readFile(join(f.snapshot, 'session.json'), 'utf8')).draft, '未发送草稿')
    await assert.rejects(RecoveryPackage.open(join(f.snapshot, 'output'), f.request), /inside the original/)
    await assert.rejects(stat(join(f.snapshot, 'output')), { code: 'ENOENT' })
})

test('a foreign SQLite file cannot be adopted or mutated as an output journal', async t => {
    const f = await fixture(t)
    await mkdir(f.output)
    const path = join(f.output, 'recovery.sqlite'), database = new DatabaseSync(path)
    database.exec('CREATE TABLE unrelated(id TEXT)'); database.close()
    const before = await readFile(path)
    await assert.rejects(RecoveryPackage.open(f.output, f.request))
    assert.deepEqual(await readFile(path), before)
})
