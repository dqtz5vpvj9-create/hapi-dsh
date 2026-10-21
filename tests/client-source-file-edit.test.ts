import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NativeWorkbenchApi, WorkbenchResponse } from '../src/workbench-types.ts'
import { SourceFileEdit } from '../src/client/source-file-edit.ts'
import { discardNativeDocumentDraft } from '../src/client/workbench-drafts.ts'
import type { NativeDocumentJournal } from '../src/client/native-document-journal.ts'

function fixture() {
  const source = { sourceSessionId: crypto.randomUUID(), sourceHubId: 'fixture-hub', machineId: 'source-runner' }
  let file: WorkbenchResponse<'nativeDocument'> = { document: { kind: 'file', path: '/source/file.txt' }, fileName: 'file.txt',
    mimeType: 'text/plain', size: 8, writable: true, text: 'original', hash: 'a'.repeat(64), format: { bom: true, eol: '\r\n' },
    downloadUrl: '/fixture/file', officePreview: false }
  const saves: Parameters<NativeWorkbenchApi['nativeFileSave']>[0][] = []
  let saveGate: Promise<void> | undefined, loseAck = false
  const api: Pick<NativeWorkbenchApi, 'nativeDocument' | 'nativeFileSave'> = {
    nativeDocument: async () => ({ ok: true, value: structuredClone(file) }),
    nativeFileSave: async request => {
      saves.push(structuredClone(request)); await saveGate
      if (request.expectedHash !== file.hash) return { ok: true, value: { success: false, code: 'conflict' } }
      file = { ...file, text: request.text, hash: 'b'.repeat(64) }
      if (loseAck) throw new Error('The source saved the file but its acknowledgement was lost')
      return { ok: true, value: { success: true, hash: file.hash! } }
    },
  }
  return { source, api, saves, editor: new SourceFileEdit(api, source, '/source/file.txt'),
    change: (text: string) => { file = { ...file, text, hash: 'c'.repeat(64) } },
    loseAck: () => { loseAck = true }, gate: (value: Promise<void>) => { saveGate = value } }
}

test('source edit submits its loaded CAS revision and original BOM/line endings while preserving later local edits', async () => {
  const f = fixture(); await f.editor.load(); f.editor.edit('first draft')
  let release!: () => void; f.gate(new Promise(resolve => { release = resolve }))
  const save = f.editor.save(); f.editor.edit('later draft'); release(); await save
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0]?.expectedHash, 'a'.repeat(64))
  assert.deepEqual(f.saves[0]?.format, { bom: true, eol: '\r\n' })
  assert.equal(f.editor.getSnapshot().base?.text, 'first draft'); assert.equal(f.editor.getSnapshot().text, 'later draft')
  assert.equal(f.editor.dirty, true); assert.equal(f.editor.getSnapshot().saved, false)
  f.editor.discard()
})

test('lost save acknowledgement survives view recreation, source inspection never replays, and explicit rebase retains the draft', async () => {
  const f = fixture(); await f.editor.load(); f.editor.edit('saved draft'); f.loseAck(); await f.editor.save()
  const restored = new SourceFileEdit(f.api, f.source, '/source/file.txt')
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
  assert.equal(f.saves.length, 2); assert.equal(f.saves[1]?.expectedHash, 'c'.repeat(64))
  assert.equal(f.editor.dirty, false)
})

test('a cold editor restores durable bytes and an uncertain CAS baseline without replaying a source save', async () => {
  const f = fixture(); await f.editor.load(); f.editor.edit('retained across document replacement'); f.loseAck(); await f.editor.save(); await f.editor.checkpoint()
  discardNativeDocumentDraft(f.source, { kind: 'file', path: '/source/file.txt', machineId: f.source.machineId })
  const cold = new SourceFileEdit(f.api, f.source, '/source/file.txt'); assert.equal(cold.getSnapshot().base, undefined)
  await cold.load(); assert.equal(cold.getSnapshot().text, 'retained across document replacement'); assert.equal(cold.getSnapshot().uncertain, true)
  await cold.save(); assert.equal(f.saves.length, 1); assert.equal(cold.getSnapshot().base?.hash, 'a'.repeat(64))
  cold.acceptCurrent(true); await cold.checkpoint()
})

test('browser storage failure prevents dispatch while retaining the editable draft', async () => {
  const f = fixture(); let attempts = 0
  const denied: NativeDocumentJournal = { async read() { return null }, async write() { attempts++; throw new Error('Storage quota exceeded') } }
  const editor = new SourceFileEdit(f.api, { ...f.source, sourceHubId: crypto.randomUUID() }, '/source/file.txt', denied)
  await editor.load(); editor.edit('never lose this edit'); await editor.save()
  assert.equal(f.saves.length, 0); assert.equal(editor.getSnapshot().text, 'never lose this edit'); assert.equal(editor.dirty, true)
  assert.match(editor.getSnapshot().error!, /quota/u); await assert.rejects(editor.checkpoint(), /quota/u); assert.ok(attempts > 0)
})

test('concurrent browser editors expose both drafts and require an explicit CAS resolution without a source write', async () => {
  const f = fixture()
  const first = f.editor, second = new SourceFileEdit(f.api, f.source, '/source/file.txt')
  await first.load(); await second.load()
  first.edit('first window draft'); await first.checkpoint()
  second.edit('second window draft'); await assert.rejects(second.checkpoint(), /newer draft/u)
  assert.equal(second.getSnapshot().text, 'second window draft'); assert.equal(f.saves.length, 0)
  await second.inspectBrowserDraft(); assert.equal(second.getSnapshot().browserDraft?.text, 'first window draft')
  await second.resolveBrowserDraft(false); await second.checkpoint()
  assert.equal(second.getSnapshot().text, 'second window draft'); assert.equal(second.getSnapshot().error, null)
  await first.inspectBrowserDraft(); assert.equal(first.getSnapshot().browserDraft?.text, 'second window draft')
  await first.resolveBrowserDraft(true); await first.checkpoint()
  assert.equal(first.getSnapshot().text, 'second window draft'); assert.equal(first.getSnapshot().base?.hash, 'a'.repeat(64)); assert.equal(f.saves.length, 0)
})
