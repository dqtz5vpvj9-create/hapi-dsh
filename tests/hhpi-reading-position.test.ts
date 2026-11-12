/** Real accepted-window publication and source epochs; native transport and reader acceptance are controlled. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { RemoteSourceHistory } from '../src/client/remote-history.ts'
import { sourceReadingPosition } from '../src/client/source-reading-commit.ts'
import { sourceSessionId, type SourceChanges, type SourceEntry, type SourcePage, type SourceSession } from '../src/remote/protocol.ts'
import { officialChat } from './official-conversation-fixture.ts'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'

test('a read position uses only the accepted Pane version and its original epoch and event time', async t => {
    const identity = { machineId: 'reading-machine', sourceId: 'native', engine: 'codex', nativeId: 'reading-thread' }
    const source: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Fixture', cwd: '/synthetic', updatedAt: 1999999999999,
        status: 'idle', activeTurnId: null, capabilities: { send: false, steer: false, cancel: false, approve: false, files: false }, pendingRequests: [] }
    const native = Session.create(SessionId(source.id)), body = native.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'real original body' }] }), { surfaceOp: 'append' })
    const entries = [{ type: 'event' as const, event: body }], changed = Promise.withResolvers<SourceChanges>()
    let epoch = 'old-source', version = 1
    const owner = new RemoteSourceHistory(source.id, {
        async read(): Promise<SourcePage> { return { session: source, epoch, version, entries: entries as SourceEntry[], before: body.seq, after: body.seq, hasBefore: false, hasAfter: false, context: [] } },
        async *changes(request, signal) {
            if (request.epoch === 'old-source') {
                const stop = new Promise<null>(resolve => { if (signal?.aborted) resolve(null); else signal?.addEventListener('abort', () => resolve(null), { once: true }) })
                const next = await Promise.race([changed.promise, stop]); if (!next) return; yield next
            }
            if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
        },
    })
    const chat = officialChat(); t.after(async () => { owner.dispose(); await chat.close() })
    chat.assembler.replaceWindow(entries, false); chat.assembler.activateTarget('chat'); chat.assembler.flush()
    const snapshot = chat.assembler.snapshot('chat'), node = snapshot.order.map(key => snapshot.nodes.get(key)).find(node => node?.kind === 'user') as ChatConversationViewNode
    assert.ok(node)
    const budget = { events: 100, bytes: 1024 * 1024, nodes: 100 }, feed = await owner.openView('actual-pane-window', budget)
    const binding = { sessionId: source.id, session: { readingWindowPosition: (version: string, seq: number) => owner.acceptedReadingPosition('actual-pane-window', version, seq) } } as unknown as SessionBinding
    assert.equal(sourceReadingPosition(binding, node, entries, feed.initial.version), undefined, 'a source fetch and prepared candidate are not reader acceptance')
    feed.publication!.accept(feed.initial.version)
    assert.deepEqual(sourceReadingPosition(binding, node, entries, feed.initial.version), { position: { kind: 'hhpi', epoch: 'old-source', seq: body.seq }, at: body.time })
    assert.equal(owner.acceptedReadingPosition('another-pane-window', feed.initial.version, body.seq), undefined)
    assert.equal(owner.acceptedReadingPosition('actual-pane-window', feed.initial.version, body.seq + 1), undefined)
    epoch = 'new-source'; version = 2
    changed.resolve({ session: source, epoch, version, base: 1, reset: true, upserts: [], removed: [] })
    for (let i = 0; i < 100 && owner.sourceEpoch !== epoch; i++) await setImmediate()
    assert.equal(owner.sourceEpoch, epoch)
    assert.equal(sourceReadingPosition(binding, node, entries, feed.initial.version), undefined, 'a canonical successor epoch cannot label the old accepted body')
    const candidate = await feed.read({ kind: 'latest' }, budget, new AbortController().signal)
    assert.equal(sourceReadingPosition(binding, node, entries, candidate.version), undefined, 'the successor still needs actual publication acceptance')
    feed.publication!.accept(candidate.version)
    assert.deepEqual(sourceReadingPosition(binding, node, entries, candidate.version), { position: { kind: 'hhpi', epoch, seq: body.seq }, at: body.time })
    feed.release()
    assert.equal(owner.acceptedReadingPosition('actual-pane-window', candidate.version, body.seq), undefined)
});
