/** Real pinned snapshot store; editor operations and browser storage are protocol fixtures. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CommandClaim, InputActions, InputState, SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ComposerAutosaves, composerDraftKey, readComposerRecoveries, appendRecoveredDraft } from '../src/client/composer-autosave.ts'

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

test('closing the newest source composer returns autosave to the surviving generation without replacing either draft', () => {
    const s = setup(), old = fixture('old text'), oldStop = s.bind(old)
    const next = fixture(), nextStop = s.bind(next)
    next.edit('newer text')
    nextStop(); nextStop()
    assert.equal(s.saved().text, 'newer text', 'ownership handoff must not flush the older editor')
    assert.equal(old.composer.state.getSnapshot().draft, 'old text', 'handoff must not overwrite a live editor')
    old.composer.state.set({ ...old.composer.state.getSnapshot(), queue: [] })
    assert.equal(s.saved().text, 'newer text', 'an unrelated input notification must not flush the older editor')
    // This edit deliberately returns to its previous value: a previous-write
    // cache belongs to the old ownership interval, not the current storage.
    old.edit('old text')
    assert.equal(s.saved().text, 'old text')
    old.edit('continued after the newer pane closed')
    oldStop()
    const reload = fixture(), reloadStop = s.bind(reload)
    assert.equal(reload.composer.state.getSnapshot().draft, 'continued after the newer pane closed')
    reloadStop()
    assert.deepEqual(s.errors, [])
})

test('closing an unedited reclaimed composer preserves the last owner backup', () => {
    const s = setup(), old = fixture('older'), oldStop = s.bind(old)
    const next = fixture(), nextStop = s.bind(next)
    next.edit('latest durable draft')
    nextStop(); oldStop()
    assert.equal(s.saved().text, 'latest durable draft')
    old.edit('already disposed')
    assert.equal(s.saved().text, 'latest durable draft')
})

test('successive owner closes return saving to the newest surviving generation', () => {
    const s = setup(), first = fixture('first'), firstStop = s.bind(first)
    const second = fixture(), secondStop = s.bind(second)
    const third = fixture(), thirdStop = s.bind(third)
    third.edit('third'); thirdStop()
    first.edit('older background editor')
    assert.equal(s.saved().text, 'third')
    second.edit('continued in second')
    assert.equal(s.saved().text, 'continued in second')
    secondStop()
    first.edit('continued in first')
    assert.equal(s.saved().text, 'continued in first')
    firstStop()
})

test('owner handoff skips closed generations, keeps duplicate users and remains source-specific', () => {
    const s = setup(), first = fixture('first'), firstStop = s.bind(first), duplicateStop = s.bind(first)
    const middle = fixture(), middleStop = s.bind(middle)
    const newest = fixture(), newestStop = s.bind(newest)
    const other = fixture('other hub'), otherKey = composerDraftKey('host', 'display', { hubId: 'other', hapiSessionId: 'original' })
    const otherStop = s.bind(other, { key: otherKey })
    middleStop(); firstStop()
    newest.edit('newest owns this source')
    assert.equal(s.saved().text, 'newest owns this source')
    newestStop()
    first.edit('the surviving duplicate keeps saving')
    middle.edit('closed middle cannot save')
    other.edit('other hub stays independent')
    assert.equal(s.saved().text, 'the surviving duplicate keeps saving')
    assert.equal(JSON.parse(s.data.get(otherKey)!).draft.text, 'other hub stays independent')
    duplicateStop(); otherStop()
    assert.deepEqual(s.errors, [])
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


test('a conflicting official draft preserves the backup and append keeps both texts', () => {
    const s = setup(), old = fixture('newer backup'); s.bind(old)()
    const current = fixture('older official'); const stop = s.bind(current)
    const recovered = readComposerRecoveries(s.storage, s.key)
    assert.equal(recovered[0]?.text, 'newer backup')
    assert.equal(current.composer.state.getSnapshot().draft, 'older official')
    appendRecoveredDraft(current.composer, current.actions, recovered[0]!)
    assert.equal(current.composer.state.getSnapshot().draft, 'older official\n\nnewer backup')
    stop()
})
