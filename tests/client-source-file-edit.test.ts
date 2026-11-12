import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkspaceFileSaveRequest } from '../src/workbench-types.ts'
import type { WorkspaceDocument, WorkspaceMutationResult } from '../src/workspace/service-types.ts'
import { fileContext, fileOwner } from './source-file-context-fixture.ts'
import { SourceFileEdit } from '../src/client/source-file-edit.ts'
import { discardSourceDocumentDraft } from '../src/client/workbench-drafts.ts'
import type { NativeDocumentJournal } from '../src/client/native-document-journal.ts'

function fixture() {
  const context = fileContext(), source = context.owner
  let file: WorkspaceDocument = { resource: { target: source.binding.target, document: { kind: 'file', path: '/source/file.txt' } }, fileName: 'file.txt',
    mimeType: 'text/plain', bytes: 8, writable: true, text: 'original', version: 'stat:initial', format: { bom: true, eol: '\r\n' } }
  const saves: WorkspaceFileSaveRequest[] = [], receipts = new Map<string, WorkspaceMutationResult<{absolutePath:string;version:string;bytes:number}>>()
  let saveGate: Promise<void> | undefined, loseAck = false, version = 0
  context.services.documents.open = async () => structuredClone(file)
  context.services.mutations!.save = async request => {
    saves.push(structuredClone(request)); await saveGate
    if (request.baseline.kind !== 'version' || request.baseline.version !== file.version) return { status: 'conflict', operationId: request.operationId, currentVersion: file.version }
    file = { ...file, text: request.text, version: `stat:saved:${++version}` }
    const result = { status: 'applied' as const, operationId: request.operationId, value: {absolutePath:'/source/file.txt', version:file.version, bytes:8} }
    receipts.set(request.operationId,result)
    if (loseAck) throw new Error('The source saved the file but its acknowledgement was lost')
    return result
  }
  context.services.mutations!.receipt = async id => receipts.get(id) ?? null
  return { source, context, saves, editor: new SourceFileEdit(context, '/source/file.txt'),
    change: (text: string) => { file = { ...file, text, version: 'stat:external' } },
    loseAck: () => { loseAck = true }, gate: (value: Promise<void>) => { saveGate = value } }
}

test('source edit submits its loaded opaque source version and original BOM/line endings while preserving later local edits', async () => {
  const f = fixture(); await f.editor.load(); f.editor.edit('first draft')
  let release!: () => void; f.gate(new Promise(resolve => { release = resolve }))
  const save = f.editor.save(); f.editor.edit('later draft'); release(); await save
  assert.equal(f.saves.length, 1); assert.deepEqual(f.saves[0]?.baseline, {kind:'version',version:'stat:initial'})
  assert.deepEqual(f.saves[0]?.format, { bom: true, eol: '\r\n' })
  assert.equal(f.editor.getSnapshot().base?.text, 'first draft'); assert.equal(f.editor.getSnapshot().text, 'later draft')
  assert.equal(f.editor.dirty, true); assert.equal(f.editor.getSnapshot().saved, false)
  f.editor.discard()
})

test('lost save acknowledgement survives view recreation, source inspection never replays, and explicit rebase retains the draft', async () => {
  const f = fixture(); await f.editor.load(); f.editor.edit('saved draft'); f.loseAck(); await f.editor.save()
  const restored = new SourceFileEdit(f.context, '/source/file.txt')
  assert.equal(restored.getSnapshot().text, 'saved draft'); assert.equal(restored.getSnapshot().uncertain, true)
  await restored.load(); await restored.save(); await restored.inspect()
  assert.equal(f.saves.length, 1); assert.equal(restored.getSnapshot().current?.text, 'saved draft')
  restored.acceptCurrent(true); assert.equal(restored.dirty, false)
})

test('a source conflict blocks another save until the user explicitly reviews a fresh baseline', async () => {
  const f = fixture(); await f.editor.load(); f.editor.edit('my draft'); f.change('another editor')
  await f.editor.save(); await f.editor.save(); assert.equal(f.saves.length, 1)
  assert.equal(f.editor.getSnapshot().uncertain, true); await f.editor.inspect()
  assert.equal(f.editor.getSnapshot().current?.text, 'another editor'); assert.equal(f.editor.getSnapshot().text, 'my draft')
  f.editor.acceptCurrent(true); await f.editor.save()
  assert.equal(f.saves.length, 2); assert.deepEqual(f.saves[1]?.baseline, {kind:'version',version:'stat:external'})
  assert.equal(f.editor.dirty, false)
})

test('a cold editor restores durable bytes and an uncertain source baseline without replaying a source save', async () => {
  const f = fixture(); await f.editor.load(); f.editor.edit('retained across document replacement'); f.loseAck(); await f.editor.save(); await f.editor.checkpoint()
  discardSourceDocumentDraft(f.source, { kind: 'file', path: '/source/file.txt' })
  const cold = new SourceFileEdit(f.context, '/source/file.txt'); assert.equal(cold.getSnapshot().base, undefined)
  await cold.load(); assert.equal(cold.getSnapshot().text, 'retained across document replacement'); assert.equal(cold.getSnapshot().uncertain, true)
  await cold.save(); assert.equal(f.saves.length, 1); assert.equal(cold.getSnapshot().base?.version, 'stat:initial')
  cold.acceptCurrent(true); await cold.checkpoint()
})

test('browser storage failure prevents dispatch while retaining the editable draft', async () => {
  const f = fixture(); let attempts = 0
  const denied: NativeDocumentJournal = { async read() { return null }, async write() { attempts++; throw new Error('Storage quota exceeded') } }
  const editor = new SourceFileEdit({ ...f.context, owner: fileOwner() }, '/source/file.txt', denied)
  await editor.load(); editor.edit('never lose this edit'); await editor.save()
  assert.equal(f.saves.length, 0); assert.equal(editor.getSnapshot().text, 'never lose this edit'); assert.equal(editor.dirty, true)
  assert.match(editor.getSnapshot().error!, /quota/u); await assert.rejects(editor.checkpoint(), /quota/u); assert.ok(attempts > 0)
})

test('concurrent browser editors expose both drafts and require an explicit CAS resolution without a source write', async () => {
  const f = fixture()
  const first = f.editor, second = new SourceFileEdit(f.context, '/source/file.txt')
  await first.load(); await second.load()
  first.edit('first window draft'); await first.checkpoint()
  second.edit('second window draft'); await assert.rejects(second.checkpoint(), /newer draft/u)
  assert.equal(second.getSnapshot().text, 'second window draft'); assert.equal(f.saves.length, 0)
  await second.inspectBrowserDraft(); assert.equal(second.getSnapshot().browserDraft?.text, 'first window draft')
  await second.resolveBrowserDraft(false); await second.checkpoint()
  assert.equal(second.getSnapshot().text, 'second window draft'); assert.equal(second.getSnapshot().error, null)
  await first.inspectBrowserDraft(); assert.equal(first.getSnapshot().browserDraft?.text, 'second window draft')
  await first.resolveBrowserDraft(true); await first.checkpoint()
  assert.equal(first.getSnapshot().text, 'second window draft'); assert.equal(first.getSnapshot().base?.version, 'stat:initial'); assert.equal(f.saves.length, 0)
})

test('external source changes preserve the dirty editor selection and never replace its text', async () => {
  const f = fixture(); await f.editor.load(); f.editor.edit('本地 draft', { start: 1, end: 4, direction: 'backward' }); await f.editor.checkpoint()
  f.change('external source update'); await f.editor.load()
  assert.equal(f.editor.getSnapshot().text, '本地 draft'); assert.deepEqual(f.editor.getSnapshot().selection, { start: 1, end: 4, direction: 'backward' })
  assert.equal(f.editor.getSnapshot().current?.text, 'external source update'); assert.equal(f.editor.getSnapshot().uncertain, true); assert.equal(f.saves.length, 0)
})

test('a cold editor restores the durable cursor with its exact account and pending operation without dispatch', async () => {
  const f = fixture(); await f.editor.load(); f.editor.edit('retained text', { start: 2, end: 8, direction: 'forward' }); f.loseAck(); await f.editor.save()
  const id = f.editor.getSnapshot().pending?.operationId
  discardSourceDocumentDraft(f.source, { kind: 'file', path: '/source/file.txt' })
  const cold = new SourceFileEdit(f.context, '/source/file.txt'); await cold.load()
  assert.equal(cold.getSnapshot().text, 'retained text'); assert.deepEqual(cold.getSnapshot().selection, { start: 2, end: 8, direction: 'forward' })
  assert.equal(cold.getSnapshot().pending?.operationId, id); await cold.save(); assert.equal(f.saves.length, 1)
  const otherOwner = { ...f.source, scope: 'different-authenticated-account' }, other = new SourceFileEdit(fileContext(otherOwner), '/source/file.txt')
  await other.load(); assert.equal(other.getSnapshot().text, 'original'); assert.equal(other.getSnapshot().pending, null)
})

test('browser storage absence never uses an in-memory success and prevents source dispatch', async () => {
  const { BrowserNativeDocumentJournal } = await import('../src/client/native-document-journal.ts')
  const context = fileContext(), editor = new SourceFileEdit(context, '/source/file.txt', new BrowserNativeDocumentJournal()); let sent = 0
  context.services.mutations!.save = async request => { sent++; return { status: 'applied', operationId: request.operationId, value: { absolutePath: request.path, version: 'bad' } } }
  await editor.load(); assert.match(editor.getSnapshot().error ?? '', /Durable browser storage is unavailable/)
  assert.equal(editor.retained, false); await editor.save(); assert.equal(sent, 0)
})
