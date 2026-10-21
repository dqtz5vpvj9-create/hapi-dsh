/** Event/attachment owners below are explicit fixtures. Real Lexical, menus and uploads are covered by Playwright. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ComposerAttachmentsOwnerProps, DraftAttachmentId, DraftFileUpload, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ComposerEnterBehavior, type ComposerEnterEvent, type ComposerEnterInput, type ComposerEnterIssue } from '../src/client/composer-enter/behavior.ts'
import { inspectComposerAttachments, type ComposerAttachmentAdmission } from '../src/client/composer-enter/attachments.ts'
import { COMPOSER_ENTER_KEY, readComposerEnterPreference, writeComposerEnterPreference, type ComposerEnterPreference } from '../src/client/composer-enter/preferences.ts'
import { createWorkspaceUiPreferences } from '../src/client/ui-preferences.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { arbitrateComposerEnter } from '../src/client/composer-enter/triggers.ts'

function key(values: Partial<ComposerEnterEvent> = {}): ComposerEnterEvent & { stopped: boolean } {
  return { key: 'Enter', defaultPrevented: false, stopped: false, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
    isComposing: false, keyCode: 13, repeat: false, getModifierState: () => false,
    preventDefault() { Object.assign(this, { defaultPrevented: true }) }, stopPropagation() { Object.assign(this, { stopped: true }) }, ...values }
}
function fixture() {
  let preference: ComposerEnterPreference = 'newline', clock = 100, identity = {}, available = true, blocked = false
  let draft = 'selected draft', phase: InputState['phase'] = 'plain', ids: DraftAttachmentId[] = []
  let outcome: 'pass' | 'consumed' | 'pick-highlighted' = 'pass', admission: ComposerAttachmentAdmission = 'ready'
  let beforeArbitrate = () => {}, submit = 0, arbitration = 0
  const notices: ComposerEnterIssue[] = []
  const actions: ComposerEnterInput['actions'] = { submit() { submit++ } }
  const behavior = new ComposerEnterBehavior({ preference: () => preference, current: () => available ? {
    identity, actions, state: { draft, phase, attachmentIds: ids }, blocked,
    arbitrate() { arbitration++; beforeArbitrate(); return outcome }, attachments: () => admission, notify: issue => { notices.push(issue) },
  } : undefined }, () => clock)
  return { behavior, notices, sent: () => submit, arbitration: () => arbitration,
    preference(value: ComposerEnterPreference) { preference = value }, phase(value: InputState['phase']) { phase = value },
    draft(value: string) { draft = value }, attachments(value: ComposerAttachmentAdmission) { admission = value; ids = ['fixture-id' as DraftAttachmentId] },
    outcome(value: typeof outcome) { outcome = value }, block() { blocked = true }, disappear() { available = false },
    afterArbitrate(run: () => void) { beforeArbitrate = run }, replace() { identity = {} },
    advance(ms: number) { clock += ms },
  }
}

test('send mode leaves the official Enter, accelerated Enter and candidate behavior untouched', () => {
  const f = fixture(); f.preference('send')
  for (const event of [key(), key({ ctrlKey: true }), key({ metaKey: true }), key({ repeat: true })]) {
    assert.equal(f.behavior.handle(event, true), false); assert.equal(event.defaultPrevented, false); assert.equal(event.stopped, false)
  }
  assert.equal(f.arbitration(), 0); assert.equal(f.sent(), 0)
})

test('admitted newline retains native beforeinput under the original editor owner', () => {
  const f = fixture(), event = key()
  assert.equal(f.behavior.handle(event, true), true)
  assert.equal(event.defaultPrevented, false); assert.equal(event.stopped, true)
  assert.equal(f.sent(), 0); assert.equal(f.arbitration(), 1)
  assert.deepEqual(f.notices, [])
})

test('both Ctrl and Cmd submit once through the ordinary owner and never insert a line break', () => {
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    const f = fixture(), event = key(modifier); f.behavior.handle(event, true)
    assert.equal(f.sent(), 1); assert.equal(event.defaultPrevented, true); assert.equal(f.arbitration(), 1)
    const held = key({ ...modifier, repeat: true }); f.behavior.handle(held, true)
    assert.equal(held.defaultPrevented, true)
    assert.equal(f.sent(), 1); assert.equal(f.arbitration(), 1)
  }
})

test('composition confirmation remains browser-owned, including legacy 229 and the late closing Enter', () => {
  const f = fixture()
  for (const event of [key({ isComposing: true }), key({ keyCode: 229 })]) {
    assert.equal(f.behavior.handle(event, true), false); assert.equal(event.defaultPrevented, false)
  }
  f.behavior.compositionStart(); const composing = key({ ctrlKey: true })
  assert.equal(f.behavior.handle(composing, true), false)
  f.behavior.compositionEnd(); f.advance(9)
  assert.equal(f.behavior.handle(key(), true), false)
  f.advance(1); assert.equal(f.behavior.handle(key(), true), true)
  assert.equal(f.sent(), 0)
})

test('Shift, Alt, AltGraph and combined platform chords keep the original keyboard owner', () => {
  const f = fixture()
  for (const event of [key({ shiftKey: true }), key({ altKey: true }), key({ ctrlKey: true, metaKey: true }),
    key({ ctrlKey: true, shiftKey: true }), key({ getModifierState: name => name === 'AltGraph' })]) {
    assert.equal(f.behavior.handle(event, true), false); assert.equal(event.defaultPrevented, false)
  }
  assert.equal(f.sent(), 0)
})

test('ready and refining candidate menus consume Enter before newline or send', () => {
  for (const outcome of ['consumed', 'pick-highlighted'] as const) for (const modifier of [{}, { ctrlKey: true }]) {
    const f = fixture(); f.outcome(outcome)
    const event = key(modifier)
    assert.equal(f.behavior.handle(event, true), true)
    assert.equal(event.defaultPrevented, true); assert.equal(f.arbitration(), 1); assert.equal(f.sent(), 0)
  }
  const f = fixture(), held = key({ repeat: true }); f.behavior.handle(held, true)
  assert.equal(held.defaultPrevented, true); assert.equal(f.arbitration(), 0)
})

test('first suggestion and pending refinement stay under the official trigger controller', () => {
  const menu = createSnapshotStore<MenuState>({ open: true, hit: null, generation: 1, highlight: null,
    groups: [{ source: 'fixture-files', status: 'pending', items: [] }] })
  const calls: string[] = []
  const controller = { menu, arbitrate(gesture: string) {
    calls.push(gesture)
    if (gesture === 'down') { menu.set({ ...menu.getSnapshot(), highlight: { source: 'fixture-files', index: 0 } }); return 'consumed' as const }
    return menu.getSnapshot().highlight ? 'pick-highlighted' as const : 'pass' as const
  } }
  assert.equal(arbitrateComposerEnter(controller), 'consumed'); assert.deepEqual(calls, [])
  menu.set({ ...menu.getSnapshot(), groups: [{ source: 'fixture-files', status: 'ready', items: [{ name: 'first.ts' }] }] })
  assert.equal(arbitrateComposerEnter(controller), 'pick-highlighted'); assert.deepEqual(calls, ['down', 'enter'])
  calls.length = 0
  assert.equal(arbitrateComposerEnter(controller), 'pick-highlighted'); assert.deepEqual(calls, ['enter'])
})

test('missing, blocked, frozen and non-editable occurrences never submit or mutate the draft', () => {
  for (const prepare of [(f: ReturnType<typeof fixture>) => f.disappear(), (f: ReturnType<typeof fixture>) => f.block(),
    (f: ReturnType<typeof fixture>) => f.phase('adjudicating'), (f: ReturnType<typeof fixture>) => f.phase('submitting')]) {
    const f = fixture(); prepare(f)
    for (const event of [key(), key({ metaKey: true })]) { f.behavior.handle(event, true); assert.equal(event.defaultPrevented, true) }
    assert.equal(f.sent(), 0); assert.equal(f.arbitration(), 0)
  }
  const f = fixture()
  for (const event of [key(), key({ ctrlKey: true })]) { f.behavior.handle(event, false); assert.equal(event.defaultPrevented, true) }
  assert.equal(f.sent(), 0)
})

test('a menu callback that switches Session generation cannot apply the old key to the new composer', () => {
  const f = fixture(); f.afterArbitrate(f.replace)
  for (const event of [key(), key({ ctrlKey: true })]) { f.behavior.handle(event, true); assert.equal(event.defaultPrevented, true) }
  assert.equal(f.sent(), 0)
})

test('attachments block ordinary shortcut submission until the original owner reports ready', () => {
  const f = fixture(); f.draft('')
  f.behavior.handle(key({ ctrlKey: true }), true); assert.equal(f.sent(), 0)
  for (const state of ['unavailable', 'uploading', 'error'] as const) {
    f.attachments(state); f.behavior.handle(key({ ctrlKey: true }), true); assert.equal(f.sent(), 0)
  }
  assert.deepEqual(f.notices, ['unavailable', 'uploading', 'error'])
  f.attachments('ready'); f.behavior.handle(key({ ctrlKey: true }), true)
  assert.equal(f.sent(), 1)
})

test('already consumed events, other keys and disposed seats cause no secondary action', () => {
  const f = fixture()
  assert.equal(f.behavior.handle(key({ defaultPrevented: true }), true), false)
  assert.equal(f.behavior.handle(key({ key: 'a' }), true), false)
  f.behavior.dispose(); assert.equal(f.behavior.handle(key(), true), false)
  assert.equal(f.sent(), 0); assert.equal(f.arbitration(), 0)
})

test('failed arbitration cancels the native edit and reports through the original input owner', () => {
  const f = fixture(); f.afterArbitrate(() => { throw new Error('Explicit unavailable trigger fixture') })
  const event = key(); f.behavior.handle(event, true)
  assert.equal(event.defaultPrevented, true); assert.equal(f.sent(), 0); assert.deepEqual(f.notices, ['failed'])
})

test('attachment readiness uses exact requested files and refuses absent or failed upload receipts', () => {
  const image = 'image' as DraftAttachmentId, file = 'file' as DraftAttachmentId, missing = 'missing' as DraftAttachmentId
  const seat: Pick<ComposerAttachmentsOwnerProps, 'attachments' | 'uploads'> = { attachments: [
    { id: image, kind: 'image', file: new File(['image fixture'], 'image.png', { type: 'image/png' }), previewUrl: 'blob:fixture' },
    { id: file, kind: 'file', file: new File(['file fixture'], 'example.txt', { type: 'text/plain' }) },
  ], uploads: {} }
  assert.equal(inspectComposerAttachments(undefined, []), 'ready')
  assert.equal(inspectComposerAttachments(undefined, [image]), 'unavailable')
  assert.equal(inspectComposerAttachments(seat, [missing]), 'unavailable')
  assert.equal(inspectComposerAttachments(seat, [image]), 'ready')
  assert.equal(inspectComposerAttachments(seat, [file]), 'uploading')
  assert.equal(inspectComposerAttachments({ ...seat, uploads: { [file]: { status: 'uploading', loaded: 4 } } }, [file]), 'uploading')
  assert.equal(inspectComposerAttachments({ ...seat, uploads: { [file]: { status: 'error', message: 'fixture upload failure' } } }, [file]), 'error')
  assert.equal(inspectComposerAttachments({ ...seat, uploads: { [file]: { status: 'ready', receiptId: 'receipt' as Extract<DraftFileUpload, { status: 'ready' }>['receiptId'],
    file: { attachmentId: 'attachment' as AttachmentId, name: 'example.txt', bytes: 12 } } } }, [image, file]), 'ready')
})

test('original Enter preference migrates without a new namespace and failed writes retain current-page intent', () => {
  const data = new Map<string, string>([[COMPOSER_ENTER_KEY, 'newline']])
  const storage = { getItem: (name: string) => data.get(name) ?? null, setItem: (name: string, value: string) => { data.set(name, value) }, removeItem: (name: string) => { data.delete(name) } }
  const shared = createWorkspaceUiPreferences(storage)
  assert.equal(readComposerEnterPreference(shared), 'newline')
  assert.equal(writeComposerEnterPreference(shared, 'send'), true); assert.equal(data.has(COMPOSER_ENTER_KEY), false)
  data.set(COMPOSER_ENTER_KEY, 'unknown'); assert.equal(readComposerEnterPreference(shared), 'send')
  assert.equal(writeComposerEnterPreference(shared, 'newline'), true); assert.equal(data.get(COMPOSER_ENTER_KEY), 'newline')
  const failing = createWorkspaceUiPreferences({ getItem: () => null, setItem() { throw new Error('quota') }, removeItem() { throw new Error('quota') } })
  const values: string[] = []; failing.subscribe(() => values.push(readComposerEnterPreference(failing)))
  assert.equal(writeComposerEnterPreference(failing, 'newline'), false); assert.equal(readComposerEnterPreference(failing), 'newline')
  assert.equal(writeComposerEnterPreference(failing, 'send'), false); assert.equal(readComposerEnterPreference(failing), 'send')
  assert.deepEqual(values, ['newline', 'send']); shared.dispose(); failing.dispose()
})
