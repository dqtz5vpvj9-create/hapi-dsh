/** Production offline converters + resolver; selected exports and owner facts are synthetic. No live owner exists here. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { createSessionsStage, SESSION_ALIASES_OBJECT_ID, SESSION_HANDOFF_OBJECT_ID } from '../scripts/migrations/hapi-offline/sessions.ts'
import { runOfflineMigration, resumeOfflineRecovery, type ExactTarget, type OfflineRequest } from '../scripts/migrations/hapi-offline/index.ts'
import { sourceSessionId } from '../src/remote/protocol.ts'
import { SourceAliasIndex, type SourceAliasDocument } from '../src/workspace/source-aliases.ts'
import { offlineDomainFixture } from './helpers/hhpi-offline-domain-fixture.ts'
import { encodeBrowserRecovery, type BrowserRecoverySnapshot } from '../src/client/source-browser-recovery.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

const scope = { accountId: 'account-a', origin: 'https://app.example.invalid' }
const identity = { machineId: 'machine-a', sourceId: 'codex-a', engine: 'codex', nativeId: 'native-a' }
const route = { kind: 'hhpi' as const, hostId: 'host-a', sessionId: sourceSessionId(identity), identity }
const codexTarget: ExactTarget = { identity, target: route }
const hubSession = (id = 'old-a', namespace = 'ns-a') => ({ id, namespace, metadata: { flavor: 'codex', machineId: identity.machineId, codexSessionId: identity.nativeId, name: 'same title', path: '/same' }, active: false, agentState: { requests: { 'original-request': { tool: 'ask' } } } })
const browser = (entries: Array<{ key: string; value: unknown }>) => ({ version: 1, entries: entries.map(entry => ({ key: entry.key, value: typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value) })) })
const delivery = (operationId: string, changes: Record<string, unknown> = {}) => ({ version: 1, operation: { sessionId: route.sessionId, operationId, kind: 'send', text: '保留原草稿' }, createdAt: 10, attempts: 0, state: 'queued', message: 'saved', retryAt: 0, ...changes })
const outboxKey = (id: string) => `hhpi:outbox:v1:storage-a:${encodeURIComponent(id)}`
const ledger = (records: Array<{ key: string; value?: string; terminal?: true }>) => ({ version: 1, database: 'hhpi-operations-v1', store: 'operations', records })
const ledgerKey = (id: string, storageScope = 'storage-a') => JSON.stringify([storageScope, id])
type Converted = { state?: string; automaticDispatch?: boolean; automaticInstall?: boolean; nativeExecutionCompleted?: boolean; gateSatisfied?: boolean; sources?: unknown[]; content?: unknown; localId?: string; operationId?: string; nextAction?: string }
const converted = (value: { body: { value: { converted?: unknown } } }) => value.body.value.converted as Converted

test('session aliases retain exact namespace/native identities and official DSH targets; unsupported or ambiguous work remains recoverable', async t => {
    const dshIdentity = { machineId: 'machine-a', sourceId: 'dsh-old', engine: 'dsh', nativeId: 'original-dsh-session' }
    const dshRoute = { kind: 'federated-dsh' as const, hostId: 'runner-a', sessionId: dshIdentity.nativeId }
    const dsh = { id: 'dsh-owner', namespace: 'ns-a', metadata: { flavor: 'dsh', machineId: 'machine-a', dshSessionId: dshIdentity.nativeId } }
    const f = await offlineDomainFixture(t, { sessions: { version: 1, sessions: [hubSession(), hubSession('old-a', 'ns-b'), dsh,
        { id: 'unmapped', namespace: 'ns-a', metadata: { flavor: 'claude', machineId: 'machine-a', claudeSessionId: 'real-claude-id', name: 'same title', path: '/same' } }] },
    links: { version: 1, records: [{ legacy: { kind: 'hapi-display', hostId: 'old-host', displayId: 'recorded-hash-r9' }, identity }] } },
    createSessionsStage([{ inputId: 'sessions', kind: 'hub-sessions', hubId: 'old-hub' }, { inputId: 'links', kind: 'recorded-links' }], { scope, targets: [codexTarget, { identity: dshIdentity, target: dshRoute }] }))
    const document = f.objects.find(row => row.id === SESSION_ALIASES_OBJECT_ID)!.body.value.converted as SourceAliasDocument
    const aliases = new SourceAliasIndex(document, scope), policy = { scope, current: () => true, authorize: async () => true, locate: async (source: typeof route | typeof dshRoute) => source }
    const mapped = await aliases.resolve({ kind: 'hapi-session', hubId: 'old-hub', namespace: 'ns-a', sessionId: 'old-a' }, policy)
    assert.equal(mapped.status, 'resolved'); if (mapped.status === 'resolved') assert.deepEqual(mapped.source, route)
    assert.equal((await aliases.resolve({ kind: 'hapi-session', hubId: 'old-hub', sessionId: 'old-a' }, policy)).status, 'unmapped')
    const originalDsh = await aliases.resolve({ kind: 'hapi-session', hubId: 'old-hub', namespace: 'ns-a', sessionId: 'dsh-owner' }, policy)
    assert.equal(originalDsh.status, 'resolved'); if (originalDsh.status === 'resolved') assert.deepEqual(originalDsh.source, dshRoute)
    assert.equal((await aliases.resolve({ kind: 'hapi-display', hostId: 'old-host', displayId: 'recorded-hash-r8' }, policy)).status, 'unmapped')
    const missing = await aliases.resolve({ kind: 'hapi-session', hubId: 'old-hub', namespace: 'ns-a', sessionId: 'unmapped' }, policy)
    assert.equal(missing.status, 'unmapped'); if (missing.status === 'unmapped') assert.equal(missing.recovery.length, 1)
    assert.equal(f.index.status, 'needs-review')
    assert.throws(() => createSessionsStage([{ inputId: 'sessions', kind: 'hub-sessions', hubId: 'old-hub' }], { scope,
        targets: [{ identity: dshIdentity, target: { kind: 'hhpi', hostId: 'host-a', identity: dshIdentity, sessionId: sourceSessionId(dshIdentity) } }] }), /official/)
    const a = await offlineDomainFixture(t, { sessions: { version: 1, sessions: [hubSession()] } }, createSessionsStage([{ inputId: 'sessions', kind: 'hub-sessions', hubId: 'old-hub' }],
        { scope, targets: [codexTarget, { ...codexTarget, target: { ...route, hostId: 'other-host' } }] }))
    const ambiguous = new SourceAliasIndex(a.objects.find(row => row.id === SESSION_ALIASES_OBJECT_ID)!.body.value.converted, scope)
    assert.equal((await ambiguous.resolve({ kind: 'hapi-session', hubId: 'old-hub', namespace: 'ns-a', sessionId: 'old-a' }, policy)).status, 'ambiguous')
})

test('frozen Hub SQLite distinguishes queued drafts, exact native queue IDs and unknown dispatch, preserving compressed payloads', async t => {
    const root = await mkdtemp('/mnt/cache/data-cache/hhpi-x1-sqlite-'); t.after(() => rm(root, { recursive: true, force: true }))
    const snapshot = join(root, 'snapshot'); await mkdir(snapshot)
    const db = new DatabaseSync(join(snapshot, 'hub.sqlite'))
    db.exec(`PRAGMA user_version=33;
        CREATE TABLE sessions(id TEXT,namespace TEXT,metadata TEXT,agent_state TEXT,active INTEGER);
        CREATE TABLE messages(id TEXT,session_id TEXT,content BLOB,seq INTEGER,local_id TEXT,invoked_at INTEGER,scheduled_at INTEGER,delivery_state TEXT);
        CREATE TABLE session_scratchlist(session_id TEXT,entry_id TEXT,text TEXT,attachments TEXT);`)
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run('old-a', 'ns-a', JSON.stringify(hubSession().metadata), JSON.stringify(hubSession().agentState), 0)
    const text = '中文文件和待发送内容 '.repeat(100), content = { role: 'user', content: { type: 'text', text } }
    const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)')
    insert.run('queued', 'old-a', zstdCompressSync(JSON.stringify(content)), 1, 'original-local-queue', null, 999, 'queued')
    insert.run('native', 'old-a', JSON.stringify({ ...content, meta: { sentFrom: 'cli', isNativeQueuedMessage: true } }), 2, 'original-native-id', null, null, 'queued')
    insert.run('unknown', 'old-a', JSON.stringify(content), 3, 'original-uncertain-id', null, null, 'indeterminate')
    insert.run('invoked', 'old-a', JSON.stringify(content), 4, 'original-dispatch-id', 20, null, 'queued')
    db.prepare('INSERT INTO session_scratchlist VALUES(?,?,?,?)').run('old-a', 'original-note', '未发送便签', JSON.stringify([{ id: 'original-attachment' }]))
    db.close()
    const stage = createSessionsStage([{ inputId: 'hub', kind: 'hub-backup', hubId: 'old-hub', userVersion: 33 }], { scope, targets: [codexTarget] })
    const request: OfflineRequest = { version: 1, packageId: 'sqlite-package', scope: 'selected-account-origin', snapshot: { id: 'sqlite-snapshot', root: snapshot,
        inputs: [{ id: 'hub', path: 'hub.sqlite', format: 'sqlite-backup', version: 'user-version-33' }] }, requiredStages: [{ id: 'sessions', version: '1' }] }
    const output = join(root, 'recovery'), index = await runOfflineMigration(request, output, [stage])
    const objects = await Promise.all(index.objects.map(async row => ({ ...row, body: JSON.parse(await readFile(join(output, row.file), 'utf8')) })))
    const item = (id: string) => converted(objects.find(row => row.id === JSON.stringify(['hub', 'message', 'old-a', id]))!)
    assert.equal(item('queued').state, 'unsent-draft'); assert.deepEqual(item('queued').content, content)
    assert.equal(item('native').state, 'native-queue-reference'); assert.equal(item('native').localId, 'original-native-id')
    assert.equal(item('unknown').state, 'original-receipt-required'); assert.equal(item('unknown').nextAction, 'query-original-operation')
    assert.equal(item('invoked').state, 'dispatch-history'); assert.equal(item('invoked').nativeExecutionCompleted, false)
    const scratch = objects.find(row => row.id === JSON.stringify(['hub', 'scratchlist', 'old-a', 'original-note']))!
    assert.equal(scratch.state, 'unresolved'); assert.equal(converted(scratch).automaticDispatch, false)
    assert.deepEqual(await readFile(join(output, index.inputs[0]!.file)), await readFile(join(snapshot, 'hub.sqlite')))
    const other = join(root, 'wrong-version'), wrong = createSessionsStage([{ inputId: 'hub', kind: 'hub-backup', hubId: 'old-hub', userVersion: 34 }], { scope, targets: [codexTarget] })
    assert.equal((await runOfflineMigration({ ...request, packageId: 'wrong-version' }, other, [wrong])).status, 'needs-review')
})

test('canonical retirement wins over a stale outbox mirror; unknown/owner admission receipts retain the original operation without replay', async t => {
    const admitted = delivery('owner-admitted', { state: 'owner-accepted', attempts: 1, receipt: { sessionId: route.sessionId, operationId: 'owner-admitted', status: 'accepted', message: 'owner stored', ownerAdmission: { localId: 'owner-admitted', state: 'consumed' } } })
    const observed = delivery('observed', { state: 'accepted', attempts: 1, receipt: { sessionId: route.sessionId, operationId: 'observed', status: 'accepted', message: 'seen', observed: { epoch: 'original-epoch', seq: 42 } } })
    const pointer = { version: 2, operationId: 'image-missing', sessionId: route.sessionId }
    const f = await offlineDomainFixture(t, {
        browser: browser([{ key: outboxKey('retired'), value: delivery('retired') }, { key: outboxKey('owner-admitted'), value: { version: 2, operationId: 'owner-admitted', sessionId: route.sessionId } },
            { key: outboxKey('unsent'), value: delivery('unsent') }, { key: outboxKey('image-missing'), value: pointer }]),
        ledger: ledger([{ key: ledgerKey('retired'), terminal: true }, { key: ledgerKey('owner-admitted'), value: JSON.stringify(admitted) }, { key: ledgerKey('observed'), value: JSON.stringify(observed) },
            { key: ledgerKey('wrong-account', 'other-scope'), value: JSON.stringify(delivery('wrong-account')) }]),
    }, createSessionsStage([{ inputId: 'browser', kind: 'browser-storage', hostId: 'host-a', storageScope: 'storage-a' },
        { inputId: 'ledger', kind: 'operation-ledger', hostId: 'host-a', storageScope: 'storage-a' }], { scope, targets: [codexTarget] }))
    const mirror = f.objects.find(row => row.id === JSON.stringify(['browser', outboxKey('retired')]))!
    assert.equal(converted(mirror).state, 'retired-mirror')
    const owner = f.objects.find(row => row.id === JSON.stringify(['ledger', ledgerKey('owner-admitted')]))!
    assert.equal(owner.state, 'unresolved'); assert.equal(converted(owner).state, 'original-receipt-required'); assert.equal(converted(owner).operationId, 'owner-admitted')
    const confirmed = f.objects.find(row => row.id === JSON.stringify(['ledger', ledgerKey('observed')]))!
    assert.equal(converted(confirmed).state, 'confirmed-history')
    assert.equal(converted(f.objects.find(row => row.id === JSON.stringify(['browser', outboxKey('unsent')]))!).state, 'unsent-draft')
    assert.equal(f.objects.find(row => row.id === JSON.stringify(['browser', outboxKey('image-missing')]))!.state, 'unresolved')
    assert.ok(f.objects.some(row => row.reason?.includes('outside the explicitly selected')))
    for (const row of f.objects.filter(row => row.body.value.converted)) assert.notEqual(converted(row).automaticDispatch, true)
})

test('native action recovery checks original thread/source and never promotes an unconfirmed prepared action or an old receipt', async t => {
    const action = { version: 1, sessionId: route.sessionId, intent: 'settings', kind: 'settings', request: { sourceId: identity.sourceId, operationId: 'settings-op', method: 'thread/settings/update', params: { threadId: identity.nativeId, model: 'original-model' } }, phase: 'prepared', createdAt: 10, updatedAt: 11 }
    const actionId = JSON.stringify(['native-action', route.sessionId, 'settings'])
    const wrong = delivery('wrong-receipt', { attempts: 1, state: 'accepted', receipt: { operationId: 'another-id', sessionId: route.sessionId, status: 'accepted', message: 'another operation' } })
    const f = await offlineDomainFixture(t, { ledger: ledger([{ key: ledgerKey(actionId), value: JSON.stringify(action) }, { key: ledgerKey('wrong-receipt'), value: JSON.stringify(wrong) }]),
        drafts: browser([{ key: `hhpi:composer-draft:v2:${JSON.stringify(['storage-a', 'host-a', route.sessionId])}`, value: { version: 1, draft: { text: '未发送草稿', references: [{ source: 'file', ref: 'original-ref' }] } } },
            { key: `hhpi:composer-draft:v2:${JSON.stringify(['other-scope', 'host-a', route.sessionId])}`, value: { version: 1, draft: { text: '另一账号草稿', references: [] } } },
            { key: 'hapi-dsh:composer-draft:v1:["hapi","old-hub","old-a"]', value: { version: 1, draft: { text: '无账号归属', references: [] } } }]) },
    createSessionsStage([{ inputId: 'ledger', kind: 'operation-ledger', hostId: 'host-a', storageScope: 'storage-a' }, { inputId: 'drafts', kind: 'browser-storage', hostId: 'host-a', storageScope: 'storage-a' }], { scope, targets: [codexTarget] }))
    assert.equal(converted(f.objects.find(row => row.id === JSON.stringify(['ledger', ledgerKey(actionId)]))!).state, 'original-receipt-required')
    assert.match(f.objects.find(row => row.id === JSON.stringify(['ledger', ledgerKey('wrong-receipt')]))!.reason!, /another immutable/)
    const drafts = f.objects.filter(row => row.inputId === 'drafts')
    assert.equal(drafts.filter(row => row.state === 'mapped').length, 1)
    assert.equal(drafts.filter(row => row.state === 'unresolved').length, 2)
    assert.equal(converted(drafts[0]!).automaticInstall, false)
    assert.deepEqual((drafts[0]!.body.value.converted as { draft: unknown }).draft, { text: '未发送草稿', references: [{ source: 'file', ref: 'original-ref' }] })
})

test('twenty exact DSH owners including idle/inactive rows remain blocked without original-owner settlement', async t => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ machineId: 'machine-a', nativeId: `native-dsh-${i}`, ownerSession: `original-owner-${i}`, active: i < 4, thinking: false, execution: null, requests: [] }))
    const targets: ExactTarget[] = rows.map(row => ({ identity: { machineId: row.machineId, sourceId: 'dsh-native', engine: 'dsh', nativeId: row.nativeId }, target: { kind: 'federated-dsh', hostId: 'runner-a', sessionId: row.nativeId } }))
    const f = await offlineDomainFixture(t, { inventory: { at: 'selected-time', sourceId: 'dsh-native', machineId: 'machine-a', root: '/synthetic/sessions', rows } },
        createSessionsStage([{ inputId: 'inventory', kind: 'dsh-owner-inventory', hubId: 'old-hub', namespace: 'ns-a' }], { scope, targets }))
    const handoff = converted(f.objects.find(row => row.id === SESSION_HANDOFF_OBJECT_ID)!)
    assert.equal(handoff.sources!.length, 20); assert.equal(handoff.gateSatisfied, false); assert.equal(f.index.status, 'needs-review')
    assert.equal((f.objects.find(row => row.id === SESSION_ALIASES_OBJECT_ID)!.body.value.converted as SourceAliasDocument).entries.length, 20)
    for (const [i, owner] of (handoff.sources as Array<{ identity: { nativeId: string }; originalOwnerSession: string; newWriterAllowed: boolean }>).entries()) {
        assert.equal(owner.identity.nativeId, rows[i]!.nativeId); assert.equal(owner.originalOwnerSession, rows[i]!.ownerSession); assert.equal(owner.newWriterAllowed, false)
    }
})

test('repeat/resume keeps original recovery objects after exports disappear and rejects remapped package reuse', async t => {
    const inputs = [{ inputId: 'sessions', kind: 'hub-sessions' as const, hubId: 'old-hub' }], stage = createSessionsStage(inputs, { scope, targets: [codexTarget] })
    const f = await offlineDomainFixture(t, { sessions: { version: 1, sessions: [hubSession()] } }, stage)
    const bytes = await Promise.all(f.index.objects.map(row => readFile(join(f.output, row.file))))
    await rename(f.snapshot, join(f.root, 'moved-exports'))
    // Simulate the established L1 interruption boundary: durable object, unfinished materialization.
    const journal = new DatabaseSync(join(f.output, 'recovery.sqlite'))
    journal.prepare('UPDATE objects SET materialized=0 WHERE id=?').run(f.index.objects[0]!.id); journal.close()
    await rm(join(f.output, f.index.objects[0]!.file))
    assert.deepEqual(await resumeOfflineRecovery(f.output), f.index)
    assert.deepEqual(await runOfflineMigration(f.request, f.output, [stage]), f.index)
    assert.deepEqual(await Promise.all(f.index.objects.map(row => readFile(join(f.output, row.file)))), bytes)
    await assert.rejects(runOfflineMigration(f.request, f.output, [createSessionsStage(inputs, { scope, targets: [{ ...codexTarget, target: { ...route, hostId: 'different-host' } }] })]), /selection or exact mapping changed/)
})

test('the actual browser recovery download retains each original composer and pane draft without adopting an account', async t => {
    const draft = { version: 1, draft: { text: '原浏览器的未发送草稿', references: [{ source: 'file', ref: 'original-file', offset: 0, length: 1 }] } }
    const key = 'hapi-dsh:composer-draft:v1:["hapi","old-hub","old-a"]'
    const paneKey = 'hapi-dsh:host:old-machine:pane:old-pane:dsh.conversation.original-session'
    const attachment = new File([Uint8Array.of(0, 255, 128)], '原附件.bin', { type: 'application/octet-stream', lastModified: 123 })
    const download: BrowserRecoverySnapshot = { version: 1, origin: scope.origin, createdAt: 123,
        localStorage: [{ key, value: JSON.stringify(draft) }, { key: paneKey, value: JSON.stringify({ draft: '原 Pane 草稿' }) },
            { key: 'hapi.scratchlist.v1.old-a', value: '原便签内容' }],
        databases: [{ name: 'hapi-dsh-composer-attachments', version: 1, stores: [{ name: 'drafts', records: [{ key: 'original-key', value: { attachment } }] }] }] }
    const exported = await encodeBrowserRecovery(download)
    const stage = createSessionsStage([{ inputId: 'download', kind: 'browser-storage', hostId: 'host-a', storageScope: 'storage-a' }], { scope, targets: [codexTarget] })
    const f = await offlineDomainFixture(t, { download: exported }, stage)
    for (const [originalKey, originalDraft] of [[key, draft.draft], [paneKey, '原 Pane 草稿']] as const) {
        const object = f.objects.find(row => row.id === JSON.stringify(['download', originalKey]))
        assert.ok(object, 'a downloaded draft must have its own browsable recovery object')
        const value = object.body.value.converted as { draft: unknown; state: string; automaticInstall: boolean; automaticDispatch: boolean }
        assert.equal(value.state, 'unsent-draft'); assert.deepEqual(value.draft, originalDraft)
        assert.equal(value.automaticInstall, false); assert.equal(value.automaticDispatch, false)
        assert.equal(object.target, undefined); assert.equal(object.state, 'unresolved')
    }
    const databases = f.objects.find(row => row.id === JSON.stringify(['download', 'databases']))!
    assert.deepEqual(databases.body.value.original, { origin: scope.origin, databases: (exported as { databases: unknown }).databases })
    assert.match(databases.reason!, /files recovery stage/)
    assert.equal(converted(f.objects.find(row => row.id === JSON.stringify(['download', 2, 'hapi.scratchlist.v1.old-a']))!).automaticDispatch, false)
    assert.deepEqual(JSON.parse(await readFile(join(f.output, f.index.inputs[0]!.file), 'utf8')), exported)
    const foreign = await offlineDomainFixture(t, { download: { ...(exported as object), origin: 'https://another-origin.invalid' } }, stage)
    assert.equal(foreign.objects.some(row => converted(row)?.state === 'unsent-draft'), false)
    assert.match(foreign.objects.find(row => row.inputId === 'download')!.reason!, /origin/)
    await rename(f.snapshot, join(f.root, 'original-download-moved'))
    assert.deepEqual(await runOfflineMigration(f.request, f.output, [stage]), f.index)
})
