/** Real pinned snapshot store; editor operations and browser storage are protocol fixtures. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CommandClaim, InputActions, InputState, SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ComposerAutosaves, composerDraftKey } from '../src/client/composer-autosave.ts'
import { ComposerPersistenceBindings } from '../src/client/composer-persistence.ts'

function fixture(text = '') {
    const state = createSnapshotStore<InputState>({ draft: text, draftRev: 0, occurrences: [], attachmentIds: [], phase: 'plain', queue: [] })
    const edit = (draft: string) => state.set({ ...state.getSnapshot(), draft, occurrences: [], draftRev: state.getSnapshot().draftRev + 1 })
    const clipboardOffset = (offset: number) => {
        let shift = 0
        for (const ref of state.getSnapshot().occurrences) {
            if (offset <= ref.offset - shift) break
            shift += ref.length - 1
        }
        return offset + shift
    }
    const composer: Pick<SessionInput, 'state' | 'setDraft' | 'insertReference' | 'beginCommand'> = {
        state, setDraft: edit,
        insertReference(ref, span) {
            const before = state.getSnapshot()
            if (before.draftRev !== span.draftRev) return false
            const start = clipboardOffset(span.start), end = clipboardOffset(span.end)
            const separator = before.draft[end] === ' ' ? '' : ' '
            const inserted = ref.clipboardText + separator, delta = inserted.length - (end - start)
            state.set({ ...before, draft: before.draft.slice(0, start) + inserted + before.draft.slice(end), draftRev: before.draftRev + 1,
                occurrences: [...before.occurrences.map(value => ({ ...value, offset: value.offset >= end ? value.offset + delta : value.offset })),
                    { ...ref, offset: start, length: ref.clipboardText.length, occurrenceId: before.draftRev + 1 }].sort((a, b) => a.offset - b.offset) })
            return true
        },
        beginCommand(claim, span) {
            const before = state.getSnapshot()
            if (before.draftRev !== span.draftRev) return false
            state.set({ ...before, phase: 'claimed', claim: { name: claim.name, token: claim.token }, draftRev: before.draftRev + 1 })
            return true
        },
    }
    const actions: Pick<InputActions, 'insertText'> = { insertText(text, span) {
        const before = state.getSnapshot()
        if (span.draftRev !== before.draftRev) return false
        const start = clipboardOffset(span.start), end = clipboardOffset(span.end), delta = text.length - (end - start)
        state.set({ ...before, draft: before.draft.slice(0, start) + text + before.draft.slice(end), draftRev: before.draftRev + 1,
            occurrences: before.occurrences.map(value => ({ ...value, offset: value.offset >= end ? value.offset + delta : value.offset })) })
        return true
    } }
    return { composer, actions, edit }
}

function setup() {
    const data = new Map<string, string>(), errors: unknown[] = [], manager = new ComposerAutosaves()
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
    const key = composerDraftKey('host', 'display-r1', { hubId: 'hub', hapiSessionId: 'original' })
    const bind = (input: ReturnType<typeof fixture>, extras = {}) => manager.retain({ key, storage, ...input, report: error => errors.push(error), ...extras })
    const saved = () => JSON.parse(data.get(key)!).draft
    return { manager, data, storage, key, errors, bind, saved }
}

test('every edit persists immediately and a fresh input restores after reload without a view writer', () => {
    const s = setup(), first = fixture(), stop = s.bind(first)
    first.edit('中文输入\n还没发送')
    assert.equal(s.saved().text, '中文输入\n还没发送')
    stop()
    const restored = fixture(), close = s.bind(restored)
    assert.equal(restored.composer.state.getSnapshot().draft, '中文输入\n还没发送')
    assert.deepEqual(s.errors, [])
    close()
})

test('closing either duplicate pane leaves the shared input autosaving', () => {
    for (const closeFirst of [0, 1]) {
        const s = setup(), input = fixture(), stops = [s.bind(input), s.bind(input)]
        stops[closeFirst]!(); stops[closeFirst]!()
        input.edit('surviving pane')
        assert.equal(s.saved().text, 'surviving pane')
        stops[1 - closeFirst]!()
        input.edit('disposed input')
        assert.equal(s.saved().text, 'surviving pane')
    }
})

test('official per-session persistence remains bound until the last pane closes', () => {
    const bindings = new ComposerPersistenceBindings(), actions = {} as InputActions
    let writer: ((draft: { text: string; references: [] }) => void) | undefined
    const saved: string[] = []
    const bind = (next: typeof writer) => { writer = next; return () => { if (writer === next) writer = undefined } }
    const one = bindings.retain(actions, bind, draft => saved.push(draft.text))
    const two = bindings.retain(actions, bind, draft => saved.push(draft.text))
    two(); two()
    writer?.({ text: 'still persisted in the official store', references: [] })
    assert.deepEqual(saved, ['still persisted in the official store'])
    one()
    assert.equal(writer, undefined)
})

test('a new display generation restores the original source draft and retired cleanup cannot overwrite it', () => {
    const s = setup(), old = fixture(), oldStop = s.bind(old)
    old.edit('before history reconciliation')
    assert.equal(s.key, composerDraftKey('host', 'display-r22', { hubId: 'hub', hapiSessionId: 'original' }))
    const next = fixture(), nextStop = s.bind(next)
    assert.equal(next.composer.state.getSnapshot().draft, 'before history reconciliation')
    next.edit('current generation'); old.edit('stale generation'); oldStop()
    assert.equal(s.saved().text, 'current generation')
    nextStop()
})

test('an existing input is never overwritten and explicit clearing stays cleared after reopening', () => {
    const s = setup(), old = fixture('old backup'); s.bind(old)()
    const current = fixture('new local input'), stop = s.bind(current)
    assert.equal(current.composer.state.getSnapshot().draft, 'new local input')
    current.edit(''); stop()
    const reload = fixture(), close = s.bind(reload)
    assert.equal(reload.composer.state.getSnapshot().draft, '')
    assert.equal(s.saved().text, '')
    close()
})

test('drafts remain isolated by source Hub and by ordinary DSH Host', () => {
    assert.notEqual(composerDraftKey('a', 'same'), composerDraftKey('b', 'same'))
    assert.notEqual(composerDraftKey('a', 'display', { hubId: 'one', hapiSessionId: 'same' }), composerDraftKey('a', 'display', { hubId: 'two', hapiSessionId: 'same' }))
})

test('semantic references survive recovery with punctuation, newline and repeated references', () => {
    const s = setup(), input = fixture('@a，\n@a end')
    input.composer.state.set({ ...input.composer.state.getSnapshot(), occurrences: [0, 4].map(offset => ({
        source: 'reference', ref: '/path/a', label: 'a', clipboardText: '@a', offset, length: 2, occurrenceId: offset + 1, appearance: 'file' as const,
    })) })
    s.bind(input)()
    const restored = fixture(), close = s.bind(restored)
    assert.equal(restored.composer.state.getSnapshot().draft, '@a，\n@a end')
    assert.deepEqual(restored.composer.state.getSnapshot().occurrences.map(ref => [ref.ref, ref.offset, ref.appearance]), [['/path/a', 0, 'file'], ['/path/a', 4, 'file']])
    assert.deepEqual(s.errors, [])
    close()
})

test('a command is restored without execution; delayed resolution cannot replace later typing', async () => {
    for (const typeWhileResolving of [false, true]) {
        const s = setup(), initial = fixture('/goal finish')
        initial.composer.state.set({ ...initial.composer.state.getSnapshot(), phase: 'claimed', claim: { name: 'goal', token: '/goal ' } })
        s.bind(initial)()
        let resolve!: (value: CommandClaim) => void
        const pending = new Promise<CommandClaim>(yes => { resolve = yes })
        const restored = fixture(), close = s.bind(restored, { resolveCommand: () => pending })
        assert.equal(restored.composer.state.getSnapshot().draft, '/goal finish')
        assert.deepEqual(s.saved().command, { token: '/goal ' })
        if (typeWhileResolving) restored.edit('changed while resolving')
        resolve({ name: 'goal', token: '/goal ', submit: async () => { throw new Error('Recovery must never execute a command') } })
        await pending; await Promise.resolve()
        assert.equal(restored.composer.state.getSnapshot().phase, typeWhileResolving ? 'plain' : 'claimed')
        assert.equal(restored.composer.state.getSnapshot().draft, typeWhileResolving ? 'changed while resolving' : '/goal finish')
        close()
    }
})

test('a pending submission neither restores another draft nor erases its backup before settlement', () => {
    const s = setup(), first = fixture('sending'); s.bind(first)()
    const pending = fixture()
    pending.composer.state.set({ ...pending.composer.state.getSnapshot(), phase: 'submitting' })
    const stop = s.bind(pending)
    assert.equal(pending.composer.state.getSnapshot().draft, '')
    assert.equal(s.saved().text, 'sending')
    pending.composer.state.set({ ...pending.composer.state.getSnapshot(), phase: 'plain' })
    assert.equal(s.saved().text, '')
    stop()
})

test('storage failure keeps live text, reports once, and the next edit can save after recovery', () => {
    const s = setup(), input = fixture(), original = s.storage.setItem
    const stop = s.bind(input)
    s.storage.setItem = () => { throw new Error('quota') }
    input.edit('unsaved'); input.edit('still here')
    assert.equal(input.composer.state.getSnapshot().draft, 'still here')
    assert.equal(s.errors.length, 1)
    s.storage.setItem = original
    input.edit('saved after recovery')
    assert.equal(s.saved().text, 'saved after recovery')
    stop()
})
