/** Recovery regression tests use synthetic transport and editor boundaries. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DeliveryJournal } from '../src/codex/delivery.ts'
import { NativeApprovals } from '../src/codex/approvals.ts'
import { HapiRequestError, type HapiTransport } from '../src/codex/contracts.ts'
import { queuedEditInsertDraft } from '../src/client/source-queued-edit-state.ts'
import { buildSourceResumeCommand } from '../src/client/source-resume-command.ts'
import { PaneReadingIntents } from '../src/client/reading-intent.ts'
import { sourceDiscoveryRows } from '../src/workspace/source-discovery.ts'
import { migrateMessageAppearance } from '../src/client/appearance/migration.ts'
import { createWorkspaceUiPreferences } from '../src/client/ui-preferences.ts'
import type { SourceDiscovery } from '../src/source-discovery-types.ts'

test('confirmed failure recovery replays an operation receipt without sending again, including after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-recovery-contract-'))
    let sends = 0
    const transport = { async sendMessage() { sends++; throw new HapiRequestError('Rejected by fixture', 'rejected') } } as unknown as HapiTransport
    try {
        let journal = new DeliveryJournal(directory, 'display', 'source', transport, () => {})
        const entry = journal.submit(createUserMessage({ content: [{ type: 'text', text: 'Original payload' }], source: { kind: 'user' } }), 'queue')
        await journal.settled()
        journal.recoverRejected(entry.localId, 'retry', 'explicit-retry')
        await journal.settled()
        assert.equal(sends, 2)
        journal = new DeliveryJournal(directory, 'display', 'source', transport, () => {})
        journal.recoverRejected(entry.localId, 'retry', 'explicit-retry')
        assert.equal(sends, 2)
        assert.throws(() => journal.recoverRejected(entry.localId, 'discard', 'explicit-retry'), /another action/)
        journal.recoverRejected(entry.localId, 'discard', 'explicit-discard')
        assert.equal(journal.get(entry.localId)?.state, 'discarded')
        assert.equal(journal.view().length, 0)
        assert.equal(sends, 2)
    } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a missing delivery acknowledgement cannot authorize rejected-only retry or discard', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-unknown-contract-'))
    let sends = 0
    const transport = { async sendMessage() { sends++; throw new HapiRequestError('Reply lost', 'indeterminate') } } as unknown as HapiTransport
    try {
        const journal = new DeliveryJournal(directory, 'display', 'source', transport, () => {})
        const entry = journal.submit(createUserMessage({ content: [{ type: 'text', text: 'Do once' }], source: { kind: 'user' } }), 'queue')
        await journal.settled()
        for (const action of ['retry', 'discard'] as const) assert.throws(() => journal.recoverRejected(entry.localId, action, action), /confirmed rejected/)
        assert.equal(sends, 1)
        assert.equal(journal.get(entry.localId)?.state, 'indeterminate')
    } finally { await rm(directory, { recursive: true, force: true }) }
})

test('approval disappearance and restart retain the request until a final source fact settles it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-approval-contract-'))
    let answers = 0
    const transport = { async approve() { answers++ } } as unknown as HapiTransport
    const pending = { requests: { original: { tool: 'exec', arguments: { command: 'fixture' } } } }
    try {
        let approvals = new NativeApprovals(directory, 'display', 'source', transport, () => {})
        approvals.observe(pending)
        await approvals.answer('original', { decision: 'approved' })
        approvals.observe(null)
        assert.equal(approvals.pending()[0]?.stage, 'indeterminate')
        approvals = new NativeApprovals(directory, 'display', 'source', transport, () => {})
        assert.equal(approvals.pending()[0]?.requestId, 'original')
        await assert.rejects(approvals.answer('original', { decision: 'approved' }), /no longer pending/)
        approvals.observe({ completedRequests: { original: { status: 'approved', completedAt: 42 } } })
        approvals.observe(pending)
        assert.equal(approvals.pending().length, 0)
        assert.equal(approvals.resolved()[0]?.status, 'approved')
        assert.equal(answers, 1)
    } finally { await rm(directory, { recursive: true, force: true }) }
})

test('appending cancelled text uses public insertion offsets and retains existing reference and attachment ownership', () => {
    const current = { draft: 'See @file', draftRev: 7, attachmentIds: ['image'], phase: 'plain', claim: null,
        occurrences: [{ offset: 4, length: 5 }] } as unknown as Parameters<typeof queuedEditInsertDraft>[0]
    const writes: unknown[] = []
    const actions = { captureInsertion: () => ({ start: 0, end: 5, draftRev: 7 }),
        insertText: (text: string, target: unknown) => { writes.push({ text, target }); return true }, persistDraft: () => { writes.push('persist') } }
    assert.equal(queuedEditInsertDraft(current, 'Recovered', actions).ok, false)
    assert.equal(writes.length, 0)
    assert.equal(queuedEditInsertDraft(current, 'Recovered', actions, 'append').ok, true)
    assert.deepEqual(writes, [{ text: '\n\nRecovered', target: { start: 5, end: 5, draftRev: 7 } }, 'persist'])
    assert.deepEqual(current.attachmentIds, ['image'])
    assert.equal(queuedEditInsertDraft({ ...current, draftRev: 8 }, 'Recovered', actions, 'append').ok, false)
})

test('source metadata search finds the 350th session before preview truncation', () => {
    const discovery: SourceDiscovery = { phase: 'ready', observedAt: 1, error: null, sessions: Array.from({ length: 350 }, (_, index) => ({
        hubId: 'hub', sourceSessionId: `source-${index}`, title: `Session ${index}`, engine: 'codex', machineId: 'runner', machineName: 'Runner',
        cwd: '/workspace', nativeId: `native-${index}`, updatedAt: index, active: true, thinking: false, lifecycleState: null,
        summary: null, worktree: null, subagentSearch: [], pendingRequestsCount: 0, waitingOn: [], binding: 'pending', error: null,
    })) }
    const rows = sourceDiscoveryRows(discovery, [], [], { query: 'native-349' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.source.sourceSessionId, 'source-349')
})

test('resume command quotes source paths and rejects unsupported identities instead of substituting display IDs', () => {
    const identity = { engine: 'codex', nativeId: '11111111-1111-4111-8111-111111111111', directory: "/workspace/it's here", machineId: 'source-runner', machineName: null }
    const result = buildSourceResumeCommand(identity)
    assert.equal(result.available, true)
    if (result.available) assert.equal(result.command, `cd '/workspace/it'"'"'s here' && codex resume '${identity.nativeId}'`)
    assert.equal(buildSourceResumeCommand({ ...identity, nativeId: 'display-id' }).available, false)
    assert.equal(buildSourceResumeCommand({ ...identity, directory: 'C:\\workspace' }).available, false)
})

test('reading intent revisions are independent per occurrence and a newer target invalidates old completion', () => {
    const intents = new PaneReadingIntents(), old = intents.request('left', 'session', { kind: 'latest' })
    intents.request('right', 'session', { kind: 'approval', requestId: 'request' })
    const message = intents.request('left', 'session', { kind: 'message', messageId: 'message', origin: 'search' })
    assert.equal(intents.current('left', old), false)
    assert.equal(intents.current('left', message), true)
    assert.equal(intents.read('right')?.target.kind, 'approval')
    intents.retain(new Set(['right']))
    assert.equal(intents.read('left'), undefined)
})

test('message appearance migration removes only retired bubble preferences', () => {
    const values = new Map([['hapi-user-message-bg', 'blue'], ['hapi-theme-colors', JSON.stringify({ dark: { userBubble: '#0000ff', text: '#eeeeee', extra: 'kept' }, plugin: { value: true } })]])
    const prefs = createWorkspaceUiPreferences({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } })
    migrateMessageAppearance(prefs)
    assert.equal(values.has('hapi-user-message-bg'), false)
    assert.deepEqual(JSON.parse(values.get('hapi-theme-colors')!), { dark: { text: '#eeeeee', extra: 'kept' }, plugin: { value: true } })
    prefs.dispose()
})
