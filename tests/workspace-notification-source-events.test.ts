/** Source-wide production journal/observer/adapter; native RPC and delivery are controlled boundaries. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts'
import type { CodexRpc, NativeNotification } from '../src/remote/codex-rpc.ts'
import { SourceGateway } from '../src/remote/gateway.ts'
import { sourceSessionId } from '../src/remote/protocol.ts'
import { SourceAttentionAggregateJournal, SourceNotificationObserver, attentionFromDshEvent, type SourceAttentionEvent } from '../src/workspace/notification-events.ts'
import type { AppNotification } from '../src/notification-types.ts'
const scope = { accountId: 'account', origin: 'https://workspace.example' }
const descriptor = { machineId: 'machine', id: 'source', engine: 'codex' }
const sessionId = (nativeId: string) => sourceSessionId({ machineId: descriptor.machineId, sourceId: descriptor.id, engine: descriptor.engine, nativeId })
const event = (id: string): SourceAttentionEvent => ({ id, kind: 'completed', position: { kind: 'native', turnId: id }, createdAt: 1000 })
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve)) }

test('one source journal captures 1200 previously unseen sessions without a catalog, Pane or per-session subscription', async () => {
    const lifetime = new AbortController(), journal = new SourceAttentionAggregateJournal(lifetime.signal)
    const stream = journal.attentionEvents(undefined, lifetime.signal)[Symbol.asyncIterator]()
    assert.equal((await stream.next()).value!.reset, true)
    for (let i = 0; i < 1200; i++) journal.publish(sessionId(`unseen-${i}`), event(`turn-${i}`))
    const ids = new Set<string>()
    for (let i = 0; i < 1200; i++) {
        const batch = (await stream.next()).value!
        assert.equal(batch.reset, false); assert.equal(batch.replay, false)
        ids.add(batch.events[0]!.sessionId)
    }
    assert.equal(ids.size, 1200)
    lifetime.abort(); await stream.return?.()
})

test('an admitted source cursor recovers missed native events, while first open, bounded gaps and resets establish a head', async () => {
    const lifetime = new AbortController(), journal = new SourceAttentionAggregateJournal(lifetime.signal, 2)
    journal.publish(sessionId('old'), event('before-observation'))
    let stream = journal.attentionEvents(undefined, lifetime.signal)[Symbol.asyncIterator]()
    const initial = (await stream.next()).value!
    assert.deepEqual(initial.events, [])
    await stream.return?.()
    journal.publish(sessionId('short'), event('completed-while-transport-closed'))
    stream = journal.attentionEvents(initial.cursor, lifetime.signal)[Symbol.asyncIterator]()
    const recovered = (await stream.next()).value!
    assert.equal(recovered.replay, false); assert.equal(recovered.events[0]?.event.id, 'completed-while-transport-closed')
    await stream.return?.()
    journal.publish(sessionId('next'), event('next')); journal.publish(sessionId('last'), event('last'))
    stream = journal.attentionEvents(initial.cursor, lifetime.signal)[Symbol.asyncIterator]()
    assert.equal((await stream.next()).value!.reset, true)
    journal.reset(); assert.equal((await stream.next()).value!.reset, true)
    lifetime.abort(); await stream.return?.()
})

test('actual Codex aggregate feed captures unknown short threads from shared RPC without any thread or history read', async t => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-source-attention-'), lifetime = new AbortController(), calls: string[] = []
    let notify: (value: NativeNotification) => void = () => {}, disconnect = () => {}
    const rpc = { online: true, currentGeneration: 1, connect: async () => ({}), dispose: async () => {},
        onNotification(listener: typeof notify) { notify = listener; return () => {} }, onRequest() { return () => {} },
        onDisconnect(listener: typeof disconnect) { disconnect = listener; return () => {} },
        async request(method: string) { calls.push(method); throw new Error('Source attention cannot read any thread') },
    } as unknown as CodexRpc
    const adapter = new DirectCodexAdapter({ ...descriptor, engine: 'codex' }, directory, { rpc, readMetadata: async () => { throw new Error('Source attention cannot read native history') } })
    const gateway = new SourceGateway([adapter])
    t.after(async () => { lifetime.abort(); await gateway.dispose(); await rm(directory, { recursive: true }) })
    let allowSource = true
    const stream = gateway.attentionEvents(descriptor.id, undefined, resource => resource.kind === 'source' ? allowSource : resource.id !== sessionId('denied'), lifetime.signal)[Symbol.asyncIterator]()
    assert.equal((await stream.next()).value!.reset, true)
    notify({ method: 'turn/completed', params: { threadId: 'denied', turn: { id: 'denied-turn', status: 'completed', items: [] } } })
    assert.deepEqual((await stream.next()).value!.events, [])
    notify({ method: 'turn/completed', params: { threadId: 'never-catalogued', turn: { id: 'short-turn', status: 'completed', items: [] } } })
    const fresh = (await stream.next()).value!
    assert.equal(fresh.events[0]?.sessionId, sessionId('never-catalogued'))
    assert.deepEqual(fresh.events[0]?.event.position, { kind: 'native', turnId: 'short-turn' })
    assert.deepEqual(calls, []); assert.equal((await readdir(directory)).includes('history'), false)
    allowSource = false
    notify({ method: 'turn/completed', params: { threadId: 'later', turn: { id: 'later-turn', status: 'completed', items: [] } } })
    await assert.rejects(stream.next(), /not granted/i)
    const another = gateway.attentionEvents(descriptor.id, undefined, () => true, lifetime.signal)[Symbol.asyncIterator]()
    await another.next(); const pending = another.next(); disconnect()
    await assert.rejects(pending, /connection changed/)
})

test('source observer routes dynamic ordinary DSH sessions and checks each current grant without terminating other sessions', async () => {
    const lifetime = new AbortController(), journal = new SourceAttentionAggregateJournal(lifetime.signal), notices: AppNotification[] = []
    const observer = new SourceNotificationObserver(async (_context, notice) => { notices.push(notice) })
    let denied = 'denied-session'
    const watched = observer.observeSource({ context: { scope, authorizeSource(source) {
        assert.equal(source.kind, 'local-dsh'); assert.equal(source.hostId, 'local')
        if (source.sessionId === denied) throw new Error('Current source ACL denies this session')
    } }, hostId: 'local', source: { machineId: 'local', id: 'native-dsh', engine: 'dsh' }, routeKind: 'local-dsh', feed: journal, authorizationSignal: lifetime.signal })
    try {
        await flush()
        for (const nativeId of ['denied-session', 'brand-new-session']) journal.publish(nativeId,
            attentionFromDshEvent({ type: 'turn/end', seq: 42, time: 1000, data: { reason: { kind: 'completed' } } }, { kind: 'dsh', seq: 42 })!)
        await flush()
        assert.equal(notices.length, 1)
        assert.deepEqual(notices[0]?.target, { kind: 'reading', source: { kind: 'local-dsh', hostId: 'local', sessionId: 'brand-new-session' }, position: { kind: 'dsh', seq: 42 } })
        denied = 'brand-new-session'
        journal.publish('brand-new-session', { id: 'later', kind: 'failed', position: { kind: 'dsh', seq: 43 }, createdAt: 1001 })
        await flush(); assert.equal(notices.length, 1)
        lifetime.abort(); await watched.done
        journal.publish('other-session', { id: 'after-logout', kind: 'completed', position: { kind: 'dsh', seq: 44 }, createdAt: 1002 })
        await flush(); assert.equal(notices.length, 1)
    } finally { lifetime.abort(); await observer.close() }
})

test('HHPI source observers construct full native identities and isolate repeated sources across accounts', async () => {
    const lifetime = new AbortController(), journal = new SourceAttentionAggregateJournal(lifetime.signal), notices: AppNotification[] = []
    const observer = new SourceNotificationObserver(async (_context, notice) => { notices.push(notice) })
    try {
        for (const accountId of ['account-a', 'account-b']) observer.observeSource({ context: { scope: { ...scope, accountId }, authorizeSource(source) {
            assert.equal(source.kind, 'hhpi'); if (source.kind === 'hhpi') assert.equal(source.identity.nativeId, 'new-thread')
        } }, hostId: 'owner-host', source: descriptor, feed: journal, authorizationSignal: lifetime.signal })
        await flush(); journal.publish(sessionId('new-thread'), event('original-turn')); await flush()
        assert.deepEqual(new Set(notices.map(notice => notice.scope.accountId)), new Set(['account-a', 'account-b']))
        assert.equal(notices[0]?.target.source.sessionId, sessionId('new-thread'))
        assert.equal(notices[0]?.body, '')
    } finally { lifetime.abort(); await observer.close() }
})
