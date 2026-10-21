import assert from 'node:assert/strict'
import test from 'node:test'
import { formatNativeAnswers, parseNativeQuestions, questionAnswered, questionOptions, REQUEST_USER_INPUT_OTHER, selectQuestionOption } from '../src/client/native-input.ts'
import { NativeActionLedger } from '../src/client/native-state.ts'
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
