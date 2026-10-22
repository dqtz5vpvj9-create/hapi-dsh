import assert from 'node:assert/strict'
import test from 'node:test'
import { formatNativeAnswers, parseNativeQuestions, questionAnswered, questionOptions, REQUEST_USER_INPUT_OTHER, selectQuestionOption } from '../src/client/native-input.ts'
import { NativeActionLedger, nativeRequestStateKey } from '../src/client/native-state.ts'
import { mergeCreationStates, nativeCreationRequest } from '../src/client/new-session.tsx'
import type { NativeCreationState } from '../src/client-api.ts'

test('native question parser preserves real choices and rejects unsafe or malformed URL payloads', () => {
    const parsed = parseNativeQuestions({ url: 'javascript:alert(1)', questions: [
        null, { id: '' }, { id: 'scope', question: 'Which scope?', options: [{ label: 'Local', description: 'This checkout' }, { label: 'All' }], multiple: true, isOther: true },
        { id: 'scope', question: 'Duplicated identity' },
    ] })
    assert.equal(parsed.url, null)
    assert.equal(parsed.questions.length, 1)
    const question = parsed.questions[0]!
    const options = questionOptions(question)
    assert.deepEqual(options.map(option => option.label), ['Local', 'All', REQUEST_USER_INPUT_OTHER])
    assert.deepEqual(selectQuestionOption(question, ['Local'], options[1]!), ['Local', 'All'])
    assert.deepEqual(selectQuestionOption(question, ['Local', 'All'], options[2]!), [REQUEST_USER_INPUT_OTHER])
    assert.deepEqual(selectQuestionOption(question, [REQUEST_USER_INPUT_OTHER], options[0]!), ['Local'])
    assert.equal(questionAnswered(question, { selected: [], userNote: 'Comment without selected option' }), false)
})

test('Codex answers use native nested wire format and preserve exact editor whitespace', () => {
    const parsed = parseNativeQuestions({ url: 'https://example.test/consent', questions: [
        { id: 'choice', question: 'Pick', options: [{ label: 'Yes' }] },
        { id: 'editor', question: 'Edit', inputType: 'editor', prefill: 'one\n  two\n' },
        { id: 'optional', required: false },
    ] })
    const result = formatNativeAnswers(parsed.questions, {
        choice: { selected: ['Yes'], userNote: '  explanation  ' },
        editor: { selected: [], userNote: 'line one\n  line two\n' },
    })
    assert.deepEqual(result, {
        choice: { answers: ['Yes', 'user_note: explanation'] },
        editor: { answers: ['user_note: line one\n  line two\n'] },
        optional: { answers: [] },
    })
    assert.equal(parsed.url, 'https://example.test/consent')
    assert.equal(questionAnswered(parsed.questions[1]!, { selected: [], userNote: '' }), true)
    assert.equal(questionAnswered(parsed.questions[2]!, undefined), true)
})

test('approval receipt survives component remount and never means native resolution', async () => {
    const ledger = new NativeActionLedger()
    const first = ledger.action('session', 'approval', 'request')
    let calls = 0
    let settle: (value: unknown) => void = () => {}
    const pending = first.run(() => { calls++; return new Promise(resolve => { settle = resolve }) }, true)
    assert.equal(first.getSnapshot().busy, true)
    const same = ledger.action('session', 'approval', 'request')
    assert.equal(same, first)
    assert.equal(await same.run(async () => { calls++; return undefined }, true), false)
    settle({ submitted: true }); await pending
    assert.equal(first.getSnapshot().submitted, true)
    assert.equal(first.getSnapshot().busy, false)
    assert.equal(await same.run(async () => { calls++; return undefined }, true), false)
    assert.equal(calls, 1)
    ledger.resolved('session', ['another-request'])
    assert.equal(ledger.action('session', 'approval', 'request'), first)
    ledger.resolved('session', ['request'])
    assert.notEqual(ledger.action('session', 'approval', 'request'), first)
})

test('failed native action is visible, is never replayed automatically, and permits explicit retry', async () => {
    const action = new NativeActionLedger().action('session', 'delivery', 'local-id')
    let calls = 0
    await action.run(async () => { calls++; throw { message: 'Connection lost; outcome unknown' } }, false)
    assert.equal(calls, 1)
    assert.match(action.getSnapshot().error!, /outcome unknown/)
    assert.equal(action.getSnapshot().submitted, false)
    await action.run(async () => { calls++; return { status: 'busy' } }, false)
    assert.equal(calls, 2)
    assert.deepEqual(action.getSnapshot().result, { status: 'busy' })
    assert.equal(action.getSnapshot().error, null)
})

test('display generation changes preserve pending request answers and submission ownership', async () => {
    const ledger = new NativeActionLedger()
    const first = { hubId: 'hub', hapiSessionId: 'source', sessionId: 'display-r1' }
    const next = { ...first, sessionId: 'display-r2' }
    const questions = parseNativeQuestions({ questions: [{ id: 'scope', question: 'Scope?' }] }).questions
    const draft = ledger.question(nativeRequestStateKey(first), 'request', questions)
    draft.answer('scope', { selected: [], userNote: 'keep this answer' })
    assert.equal(ledger.question(nativeRequestStateKey(next), 'request', questions), draft)
    const action = ledger.action(nativeRequestStateKey(first), 'approval', 'request')
    let calls = 0
    await action.run(async () => { calls++; return { submitted: true } }, true)
    assert.equal(await ledger.action(nativeRequestStateKey(next), 'approval', 'request').run(async () => { calls++ }, true), false)
    assert.equal(calls, 1)
    assert.notEqual(ledger.question(nativeRequestStateKey({ ...next, hubId: 'another-hub' }), 'request', questions), draft)
})

test('unsubmitted question drafts survive reload and only source resolution removes the saved answer', () => {
    const records = new Map<string, string>()
    const storage = { getItem: (key: string) => records.get(key) ?? null,
        setItem: (key: string, value: string) => { records.set(key, value) }, removeItem: (key: string) => { records.delete(key) } }
    const questions = parseNativeQuestions({ questions: [
        { id: 'choice', question: 'Pick', options: [{ label: 'Yes' }] },
        { id: 'editor', question: 'Edit', inputType: 'editor', prefill: 'initial' },
    ] }).questions
    const key = nativeRequestStateKey({ hubId: 'hub', hapiSessionId: 'source' })
    const original = new NativeActionLedger(storage)
    const draft = original.question(key, 'request', questions)
    draft.answer('choice', { selected: ['Yes'], userNote: '' })
    draft.answer('editor', { selected: [], userNote: 'line one\n  line two\n' })
    draft.update({ step: 1, error: 'temporary submission error' })
    original.clear()
    const restored = new NativeActionLedger(storage)
    assert.deepEqual(restored.question(key, 'request', questions).getSnapshot(), {
        step: 1, answers: { choice: { selected: ['Yes'], userNote: '' }, editor: { selected: [], userNote: 'line one\n  line two\n' } }, error: null,
    })
    assert.equal(restored.action(key, 'approval', 'request').getSnapshot().submitted, false)
    restored.resolved(key, ['unrelated'])
    assert.equal(records.size, 1)
    restored.resolved(key, ['request'])
    assert.equal(records.size, 0)
    assert.equal(new NativeActionLedger(storage).question(key, 'request', questions).getSnapshot().answers.editor!.userNote, 'initial')
})

test('question draft recovery keeps current question identities and tolerates unavailable storage', () => {
    const questions = parseNativeQuestions({ questions: [{ id: 'current', question: 'Edit', prefill: 'source default' }] }).questions
    const stale = new NativeActionLedger({ getItem: () => JSON.stringify({ step: 9, answers: {
        obsolete: { selected: [], userNote: 'old question' }, current: { selected: [42], userNote: 'bad shape' },
    } }), setItem() {}, removeItem() {} })
    assert.deepEqual(stale.question('source', 'request', questions).getSnapshot(), {
        step: 0, answers: { current: { selected: [], userNote: 'source default' } }, error: null,
    })
    for (const getItem of [() => '{broken json', () => { throw new Error('storage unavailable') }]) {
        const ledger = new NativeActionLedger({ getItem, setItem() { throw new Error('quota exceeded') }, removeItem() { throw new Error('storage unavailable') } })
        const draft = ledger.question('source', 'request', questions)
        draft.answer('current', { selected: [], userNote: 'live answer' })
        assert.equal(draft.getSnapshot().answers.current!.userNote, 'live answer')
        assert.doesNotThrow(() => ledger.resolved('source', ['request']))
    }
})

test('native session creation keeps runner defaults absent and includes explicit worktree controls', () => {
    const defaults = { machineId: 'runner', directory: '/code/project', model: '', reasoning: '', home: '', worktree: false, worktreeName: '' }
    assert.deepEqual(nativeCreationRequest(defaults, 'attempt-identity'), { machineId: 'runner', directory: '/code/project', requestId: 'attempt-identity', sessionType: 'simple' })
    assert.deepEqual(nativeCreationRequest({ ...defaults, model: 'codex', reasoning: 'high', home: '/codex-home', worktree: true, worktreeName: 'review' }, 'attempt-identity'), {
        machineId: 'runner', directory: '/code/project', requestId: 'attempt-identity', sessionType: 'worktree', worktreeName: 'review', model: 'codex', modelReasoningEffort: 'high', codexHome: '/codex-home',
    })
    assert.throws(() => nativeCreationRequest({ ...defaults, directory: ' ' }, 'id'), /directory/)
    assert.deepEqual(nativeCreationRequest({ ...defaults, worktree: true }, 'id'), { machineId: 'runner', directory: '/code/project', requestId: 'id', sessionType: 'worktree' })
})

test('an older creation poll cannot erase a newer recovered native identity', () => {
    const request = nativeCreationRequest({ machineId: 'runner', directory: '/code', model: '', reasoning: '', home: '', worktree: false, worktreeName: '' }, 'request')
    const accepted: NativeCreationState = { requestId: 'request', request, status: 'accepted', sourceSessionId: 'native-source', sessionId: null, nativeThreadId: null, createdAt: 1, updatedAt: 2, message: 'Waiting for metadata', sourceCode: null }
    const ready: NativeCreationState = { ...accepted, status: 'ready', sessionId: 'display-source', updatedAt: 3, message: null }
    const another: NativeCreationState = { ...accepted, requestId: 'another', request: { ...request, requestId: 'another' } }
    assert.deepEqual(mergeCreationStates([ready, another], [accepted]), [ready, another])
    assert.deepEqual(mergeCreationStates([accepted], [ready]), [ready])
})
