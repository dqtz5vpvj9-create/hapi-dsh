/** Frozen actual browser/journal formats through the real offline snapshot/recovery implementation. */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RecoveryPackage, type ExactTarget, type OfflineRequest } from '../scripts/migrations/hapi-offline/common.ts'
import { runOfflineMigration, resumeOfflineRecovery } from '../scripts/migrations/hapi-offline/index.ts'
import { createFilesStage, extractBrowserRecovery, type FilesStageOptions } from '../scripts/migrations/hapi-offline/files.ts'
import { offlineDomainFixture } from './helpers/hhpi-offline-domain-fixture.ts'
import { sourceSessionId } from '../src/remote/protocol.ts'
const source = { hubId: 'original-hub', sessionId: 'old-session' }, identity = { machineId: 'machine', sourceId: 'direct', engine: 'codex', nativeId: 'native-thread' }
const target: ExactTarget = { identity, target: { kind: 'hhpi', hostId: 'authorized-host', sessionId: sourceSessionId(identity), identity } }
const mapping = { sessions: [{ source, identity }], targets: [target] }
const blob = (data: Buffer) => ({ $hhpiBlob: 1, type: 'application/octet-stream', name: '原始.bin', lastModified: 123, data: data.toString('base64') })
function browser(value: unknown) { return { version: 1, origin: 'https://original.invalid', createdAt: 123, localStorage: [],
  databases: [{ name: 'hapi-dsh-composer-attachments', version: 1, stores: [{ name: 'drafts', records: [{ key: 'old-key', value }] }] }] } }
async function root(t: TestContext) {
  const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-files-test-'); t.after(() => rm(directory, { recursive: true, force: true })); return directory
}
async function extracted(t: TestContext, value: unknown) {
  const directory = await root(t), input = join(directory, 'original.json'), snapshot = join(directory, 'extracted'), output = join(directory, 'recovery')
  const raw = JSON.stringify(value, null, 3) + '\n'; await writeFile(input, raw)
  const result = await extractBrowserRecovery(input, snapshot)
  const request: OfflineRequest = { version: 1, packageId: 'test-files', scope: 'explicit-offline-scope', snapshot: result.snapshot, requiredStages: [{ id: 'files', version: '1' }] }
  return { directory, input, snapshot, output, raw, result, request }
}
function attachments(data: Buffer) { return { version: 1, revision: 'original-revision', value: { version: 1, mode: 'pending', text: 'unsent text', savedAt: 123,
  requestIds: ['original-request'], files: [{ name: '原始.bin', type: 'application/octet-stream', lastModified: 123, blob: blob(data) }],
  previous: [{ text: 'older draft retained', savedAt: 100, files: [{ name: 'previous.bin', type: 'application/octet-stream', lastModified: 100, blob: blob(Buffer.from([9, 8, 7])) }] }] } } }
async function objects(output: string, index: Awaited<ReturnType<typeof runOfflineMigration>>) {
  return Promise.all(index.objects.map(async row => ({ ...row, payload: JSON.parse(await readFile(join(output, row.file), 'utf8')) })))
}

test('browser extraction preserves original export bytes and real current/previous attachment Blobs without claiming an account', async t => {
  const bytes = Buffer.from([0, 255, 3, 128]), original = browser(attachments(bytes)), f = await extracted(t, original)
  assert.equal(await readFile(f.input, 'utf8'), f.raw); assert.equal(await readFile(join(f.snapshot, 'browser-export.json'), 'utf8'), f.raw)
  assert.equal(f.result.blobs, 2); assert.deepEqual(await readFile(join(f.snapshot, 'blobs/0.bin')), bytes)
  assert.deepEqual(await readFile(join(f.snapshot, 'blobs/1.bin')), Buffer.from([9, 8, 7]))
  assert.equal((await stat(f.snapshot)).mode & 0o777, 0o700); assert.equal((await stat(join(f.snapshot, 'blobs/0.bin'))).mode & 0o777, 0o600)
  const stage = createFilesStage({ inputs: [{ inputId: 'browser-export', kind: 'browser-export' }, { inputId: 'browser-blobs', kind: 'browser-blobs' }] })
  const index = await runOfflineMigration(f.request, f.output, [stage]), rows = await objects(f.output, index)
  const entry = rows.find(row => row.id.includes('database'))!
  assert.equal(index.status, 'needs-review'); assert.equal(entry.target, undefined); assert.equal(entry.payload.value.converted.assets.length, 2)
  assert.deepEqual(entry.payload.value.original, original.databases[0]!.stores[0]!.records[0]!.value)
  assert.equal(entry.payload.value.converted.imported, false)
})

test('dirty source editors retain original base, uncertainty and pending operation and restore only as a recovered copy', async t => {
  const base = { document: { kind: 'file', path: '/actual/source.ts' }, text: 'base\r\n', hash: 'original-baseline', writable: true,
    format: { bom: true, eol: '\r\n' }, downloadUrl: '/original/opaque', fileName: 'source.ts', mimeType: 'text/plain', size: 6, officePreview: false }
  const draft = { version: 1, revision: 'original-revision', updatedAt: 100, draft: { base, text: 'dirty\r\n', uncertain: true } }
  const current = { ...draft, version: 2, draft: { ...draft.draft, pending: { operationId: 'original-save', text: 'uncertain save', baselineVersion: 'source-opaque-version' },
    selection: { start: 1, end: 3, direction: 'backward' } } }
  const options: FilesStageOptions = { inputs: [{ inputId: 'old-draft', kind: 'document-drafts', source }, { inputId: 'current-draft', kind: 'document-drafts', source }], ...mapping }
  const f = await offlineDomainFixture(t, { 'old-draft': draft, 'current-draft': current }, createFilesStage(options))
  const converted = f.objects.filter(row => row.body.value.converted).map(row => row.body.value.converted as Record<string, unknown>)
  assert.equal(converted.length, 2); assert.deepEqual((converted[0]!.draft as typeof draft.draft).base, base)
  assert.deepEqual(converted[1]!.draft, current.draft)
  for (const value of converted) { assert.equal(value.restoreMode, 'recovered-copy'); assert.equal(value.overwriteTarget, false); assert.equal(value.requiresCurrentTargetRead, true) }
  assert.equal(f.index.status, 'complete'); assert.equal(f.index.objects.filter(row => row.state === 'mapped').length, 2)
})

test('resource metadata without actual selected bytes stays unresolved and never guesses a nearby filename', async t => {
  const journal = { version: 1, refs: { exact: { type: 'file', attachment: { attachmentId: 'exact-id', name: 'same.bin', bytes: 3 } } } }
  const f = await offlineDomainFixture(t, { journal, other: Buffer.from([1, 2, 3]) }, createFilesStage({ inputs: [{ inputId: 'journal', kind: 'artifact-journal', source }],
    binaries: [{ inputId: 'other', attachmentId: 'different-id' }], ...mapping }))
  const value = f.objects.find(row => row.body.value.converted)!.body.value.converted as { assets: unknown[]; missing: string[] }
  assert.equal(f.index.status, 'needs-review'); assert.equal(value.assets.length, 0); assert.match(value.missing[0]!, /not selected/)
})

test('real selected bytes are recoverable offline and ambiguous or wrong-length objects do not become receipts', async t => {
  const journal = { version: 1, refs: { file: { type: 'file', attachment: { attachmentId: 'same-id', name: 'file.bin', bytes: 4 } } } }
  const selected = await offlineDomainFixture(t, { journal, bytes: Buffer.from([0, 1, 2, 255]) }, createFilesStage({ inputs: [{ inputId: 'journal', kind: 'source-resource-journal', source }], binaries: [{ inputId: 'bytes', attachmentId: 'same-id' }], ...mapping }))
  const binary = selected.index.inputs.find(row => row.id === 'bytes')!
  assert.deepEqual(await readFile(join(selected.output, binary.file)), Buffer.from([0, 1, 2, 255])); assert.equal(selected.index.status, 'complete')
  const ambiguous = await offlineDomainFixture(t, { journal, a: Buffer.from([0, 1, 2, 255]), b: Buffer.from([3, 2, 1, 0]) }, createFilesStage({ inputs: [{ inputId: 'journal', kind: 'artifact-journal', source }],
    binaries: [{ inputId: 'a', attachmentId: 'same-id' }, { inputId: 'b', attachmentId: 'same-id' }], ...mapping }))
  assert.equal(ambiguous.index.status, 'needs-review')
  const wrong = await offlineDomainFixture(t, { journal, bytes: Buffer.from([1]) }, createFilesStage({ inputs: [{ inputId: 'journal', kind: 'artifact-journal', source }], binaries: [{ inputId: 'bytes', attachmentId: 'same-id' }], ...mapping }))
  assert.equal(wrong.index.status, 'needs-review')
})

test('confirmed, pending and unknown save receipts retain original IDs/status and cannot dispatch on conversion', async t => {
  const rows = ['confirmed', 'pending', 'unknown'].map((phase, index) => ({ version: 2, revision: `revision-${index}`, receipt: { operationId: `operation-${index}`, phase,
    request: { action: 'upload', path: '/recorded-only', uploadId: `original-upload-${index}` }, result: phase === 'confirmed' ? { accepted: true } : null } }))
  const f = await offlineDomainFixture(t, { receipts: rows }, createFilesStage({ inputs: [{ inputId: 'receipts', kind: 'file-receipts', source }], ...mapping }))
  const converted = f.objects.filter(row => row.body.value.converted)
  assert.equal(converted.length, 3)
  for (const [index, row] of converted.entries()) {
    assert.deepEqual(row.body.value.original, rows[index]); assert.equal((row.body.value.converted as { receiptPolicy: string }).receiptPolicy, 'preserve-original-id-and-status-no-dispatch')
  }
})

test('explicit official file aliases resolve by original attachment identity and leaf, without guessing by filename alone', async t => {
  const journal = { version: 1, refs: { a: { type: 'file', attachment: { attachmentId: 'same-id', name: 'first.bin', bytes: 2 } },
    b: { type: 'file', attachment: { attachmentId: 'same-id', name: 'second.bin', bytes: 2 } } } }
  const f = await offlineDomainFixture(t, { journal, first: Buffer.from([1, 2]), second: Buffer.from([1, 2]) }, createFilesStage({ inputs: [{ inputId: 'journal', kind: 'artifact-journal', source }],
    binaries: [{ inputId: 'first', attachmentId: 'same-id', kind: 'file', name: 'first.bin' }, { inputId: 'second', attachmentId: 'same-id', kind: 'file', name: 'second.bin' }], ...mapping }))
  assert.equal(f.index.status, 'complete')
  const assets = f.objects.filter(row => row.body.value.converted).flatMap(row => (row.body.value.converted as { assets: Array<{ inputId: string }> }).assets)
  assert.deepEqual(assets.map(value => value.inputId), ['first', 'second'])
})

test('interruption and refresh resume from captured inputs without replacing a newer or changed original', async t => {
  const f = await extracted(t, browser(attachments(Buffer.from([0, 255])))), stage = createFilesStage({ inputs: [{ inputId: 'browser-export', kind: 'browser-export' }, { inputId: 'browser-blobs', kind: 'browser-blobs' }] })
  const original = RecoveryPackage.prototype.putObject; let calls = 0
  RecoveryPackage.prototype.putObject = async function(value) { if (++calls === 2) throw new Error('interrupted materialization'); return original.call(this, value) }
  try { await assert.rejects(runOfflineMigration(f.request, f.output, [stage]), /interrupted/) } finally { RecoveryPackage.prototype.putObject = original }
  await rm(f.snapshot, { recursive: true, force: true })
  const recovered = await runOfflineMigration(f.request, f.output, [stage]), again = await runOfflineMigration(f.request, f.output, [stage])
  assert.deepEqual(again, recovered); assert.notEqual((await resumeOfflineRecovery(f.output)).status, 'incomplete')
  await assert.rejects(runOfflineMigration(f.request, f.output, [createFilesStage({ inputs: [{ inputId: 'browser-export', kind: 'browser-export' }] })]), /configuration changed|selection or exact mapping changed/)
})

test('a same-size binary paired with the wrong Blob manifest cannot satisfy recovery', async t => {
  const f = await extracted(t, browser(attachments(Buffer.from([1, 2, 3]))))
  await writeFile(join(f.snapshot, 'blobs/0.bin'), Buffer.from([9, 8, 7]))
  const result = await runOfflineMigration(f.request, f.output, [createFilesStage({ inputs: [{ inputId: 'browser-export', kind: 'browser-export' }, { inputId: 'browser-blobs', kind: 'browser-blobs' }] })])
  const row = (await objects(f.output, result)).find(value => value.id.includes('database'))!
  assert.equal(result.status, 'needs-review'); assert.match(row.payload.value.converted.missing[0], /differ from the original Blob/)
})

test('unsupported records remain accessible and a file key naming a machine never guesses its Session', async t => {
  const envelope = browser({ version: 1, revision: 'legacy', draft: { base: { document: { kind: 'file', path: '/same' }, text: 'base' }, text: 'dirty', uncertain: true } })
  envelope.databases[0]!.name = 'hapi-dsh-source-document-drafts'
  envelope.databases[0]!.stores[0]!.records[0]!.key = JSON.stringify(['file', source.hubId, identity.machineId, '/same'])
  const f = await extracted(t, envelope), stage = createFilesStage({ inputs: [{ inputId: 'browser-export', kind: 'browser-export' }], ...mapping })
  const result = await runOfflineMigration(f.request, f.output, [stage]); assert.equal(result.status, 'needs-review')
  assert.equal(result.objects.some(row => row.target), false)
  const unknown = await offlineDomainFixture(t, { future: { version: 999, rawDraft: 'retained future content', title: 'native-thread', cwd: '/same' } }, createFilesStage({ inputs: [{ inputId: 'future', kind: 'document-drafts', source }], ...mapping }))
  assert.equal(unknown.index.status, 'needs-review'); assert.deepEqual(unknown.objects[0]!.body.value.original, { version: 999, rawDraft: 'retained future content', title: 'native-thread', cwd: '/same' })
})

test('invalid Blob bytes and an existing extraction directory never overwrite the original export', async t => {
  const directory = await root(t), input = join(directory, 'original.json'), output = join(directory, 'fresh')
  const value = browser(attachments(Buffer.from([1]))); (value.databases[0]!.stores[0]!.records[0]!.value as ReturnType<typeof attachments>).value.files[0]!.blob.data = '!invalid!'
  const raw = JSON.stringify(value); await writeFile(input, raw)
  await assert.rejects(extractBrowserRecovery(input, output), /invalid base64/); assert.equal(await readFile(input, 'utf8'), raw)
  await mkdir(output); await writeFile(join(output, 'existing'), 'retain')
  await writeFile(input, JSON.stringify(browser(attachments(Buffer.from([1])))))
  await assert.rejects(extractBrowserRecovery(input, output), /EEXIST/); assert.equal(await readFile(join(output, 'existing'), 'utf8'), 'retain')
})
