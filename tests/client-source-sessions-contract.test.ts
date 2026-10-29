/**
 * Contract regression for the public client `ISessions` / `SessionFace` source facade.
 *
 * These assertions describe the required public behavior, not the implementation
 * snapshot that happened to exist when they were written. They are written to
 * fail on regressions such as lost pending/exhausted history state, a rewritten
 * caller retention source, or a tail-only outline reported as a complete source.
 *
 * The product imports `@deepseek-ai/dsh-api-session-controller/client`, whose
 * published `lib/client.js` is a browser module wrapper and cannot be imported by
 * Node directly. For this test runtime only, esbuild resolves that one public
 * specifier to the package's installed `lib/types/client/contract/events.js`
 * implementation. Product imports stay unchanged; the bundle exists in memory.
 * This proves the adapter contract, not real UI/browser acceptance.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { before, test } from 'node:test'
import { build } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ISessions, SessionBinding, SessionEventLikeEntry, SessionEventSource, SessionReference, SessionRetainInfo,
  SessionRetainOptions, SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SourcePreparationReference, SourceSessionsApi, SourceViewportSession, SourceWindowPreparer } from '../src/client/source-sessions.ts'
import { SOURCE_HISTORY_FRAME_CHUNK_SIZE } from '../src/source-window-types.ts'
import type { SourceHistoryOutlineValue, SourceHistoryWindowRequest, SourceHistoryWindowValue } from '../src/source-window-types.ts'
import { prepareInitialViewport } from '../src/client/surface/session-view.tsx'
import type { WorkspacePaneNavigation } from '../src/client/pane-navigation.ts'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { SourceHistoryWindow } from '../src/codex/source-window.ts'
import { DISPLAY_SEQ_OFFSET, openingWindow } from '../src/shared/history-window.ts'
import { NativeProjector } from '../src/codex/projector.ts'
import { parseNativeRow } from '../src/codex/native.ts'
import { nativeMemoryWorkload } from './fixtures/source-window-memory-helpers.ts'
import { HistoryProjectionSink } from '../src/shared/projection-event-sink.ts'
import { toSourceFrames } from '../src/shared/source-frame-builder.ts'
import { SOURCE_FRAME_EVENT, type SourceFrame, type SourceFrameBatch } from '../src/shared/source-frames.ts'
import type { HapiTransport } from '../src/codex/contracts.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const controllerRoot = dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'))
const contractEvents = join(controllerRoot, 'lib/types/client/contract/events.js')

interface OutlineRow {
  readonly turn: number
  readonly seq: number
  readonly prompt: string
  readonly response: string
}

interface MutableEventSource extends SessionEventSource {
  replace(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void
  prepend(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void
  append(entry: SessionEventLikeEntry): void
}

interface Facade {
  api?: SourceSessionsApi
  attach(api: SourceSessionsApi): void
  retain(target: SessionId, options: SessionRetainOptions): SessionReference
  retainInfo(id: SessionId): { getSnapshot(): SessionRetainInfo; subscribe(listener: () => void): () => void }
  binding(id: SessionId): SessionBinding | undefined
  scope(id: SessionId): SessionBinding['ctx'] | undefined
  scopeOf(ctx: Context): SessionId | undefined
  sessionOf(ctx: Context): SessionFace | undefined
  dispose(): void
}

interface Runtime {
  SourceSessions: new (original: ISessions) => Facade
  SourceWindowStore: typeof import('../src/client/source-window-store.ts').SourceWindowStore
  MutableSessionEventSource: new () => MutableEventSource
  createScope(ctx: Context, id: SessionId): { ctx: SessionBinding['ctx']; fiber: { dispose(): Promise<void> } }
  scopeOf(ctx: Context): SessionId | undefined
}

let runtime: Runtime

before(async () => {
  const contents = [
    `export { SourceSessions } from ${JSON.stringify(join(root, 'src/client/source-sessions.ts'))}`,
    `export { SourceWindowStore } from ${JSON.stringify(join(root, 'src/client/source-window-store.ts'))}`,
    `export { createScope, scopeOf } from ${JSON.stringify(join(controllerRoot, 'lib/types/client/scope.js'))}`,
    "export { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'",
  ].join('\n')
  const built = await build({
    stdin: { contents, resolveDir: root, sourcefile: 'source-sessions-contract-entry.ts', loader: 'ts' },
    alias: { '@deepseek-ai/dsh-api-session-controller/client': join(root, 'tests/fixtures/client-session-contract.ts') },
    bundle: true, platform: 'node', target: 'node24', format: 'esm',
    write: false, sourcemap: false, legalComments: 'none', logLevel: 'silent',
  })
  const source = built.outputFiles[0]?.text
  if (!source) throw new Error('esbuild produced no source-session contract bundle')
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  runtime = await import(url) as unknown as Runtime
  assert.equal(typeof runtime.SourceSessions, 'function', 'the bundled public facade must load under Node')
  assert.equal(typeof runtime.MutableSessionEventSource, 'function', 'the official event source must load under Node')
})

class ValueSource<T> {
  private value: T
  private readonly listeners = new Set<() => void>()
  constructor(value: T) { this.value = value }
  readonly getSnapshot = (): T => this.value
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(next: T): void {
    this.value = next
    for (const listener of [...this.listeners]) listener()
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function sourceId(index: number): SessionId {
  return `hapi-codex-${String(index).padStart(32, '0')}` as SessionId
}

function event(seq: number, type = 'user/message'): SessionEventLikeEntry {
  return { type: 'event', event: { type, seq, time: seq, data: {} } } as unknown as SessionEventLikeEntry
}

function sourceEvent(messageId: string, position: number): SessionEventLikeEntry {
  return { type: 'event', source: { messageId, at: position, seq: position },
    event: { type: 'user/message', seq: position, time: position, data: { id: messageId, text: messageId } } } as unknown as SessionEventLikeEntry
}

function seqs(snapshot: { readonly entries: readonly SessionEventLikeEntry[] }): number[] {
  return snapshot.entries.map(entry => Number(entry.event.seq))
}

function outlineValue(rows: readonly OutlineRow[]): SourceHistoryOutlineValue {
  return {
    entries: rows.map(row => ({ ...row, messageId: `message-${row.seq}`, at: row.seq, sourceSeq: row.seq })),
    seedIndex: 0,
    firstTurn: rows[0]?.turn ?? 0,
    // A single complete page: navigation-ready unless a test overrides it.
    complete: true,
  }
}

function windowValue(records: readonly SessionEventLikeEntry[],
  overrides: Partial<SourceHistoryWindowValue> = {}): SourceHistoryWindowValue {
  return {
    records: [...records], hasMoreBefore: true, hasMoreAfter: true,
    before: { at: 1, seq: 1 }, after: { at: 2, seq: 2 }, ...overrides,
  }
}

function apiWith(overrides: Partial<SourceSessionsApi> = {}): SourceSessionsApi {
  return {
    sourceHistoryOutline: async () => ({ ok: true, value: outlineValue([]) }),
    sourceHistoryWindowPage: async () => ({ ok: false, error: new Error('source window is unused in this case') }),
    ...overrides,
  }
}

function outlineRowsOf(binding: SessionBinding): readonly OutlineRow[] {
  return binding.session.projections.faceOf('turnOutline').getSnapshot() as readonly OutlineRow[]
}

function outlineStateOf(binding: SessionBinding): SourceViewportSession['sourceOutline'] {
  return (binding.session as SessionFace & SourceViewportSession).sourceOutline
}

/** Body readiness and directory completeness are independent public contracts. */
async function waitForOutline(binding: SessionBinding,
  status: ReturnType<SourceViewportSession['sourceOutline']['getSnapshot']>['status'], timeout = 2_000): Promise<void> {
  const source = outlineStateOf(binding)
  if (source.getSnapshot().status === status) return
  let stop: (() => void) | undefined
  const reached = new Promise<void>(resolve => {
    const check = (): void => { if (source.getSnapshot().status === status) resolve() }
    stop = source.subscribe(check)
    check()
  })
  try { await within(reached, `source directory did not become ${status}`, timeout) }
  finally { stop?.() }
}

function snapshotOf(id: SessionId, hasMore: boolean): SessionSnapshot {
  return {
    sessionId: id, pendingSubmissions: [], running: false, subagent: null, removed: false,
    openState: 'open', openError: null, hasMore, loadingOlder: false, promptError: null,
    blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false,
  }
}

async function within<T>(promise: Promise<T>, label: string, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Observe settlement without rejecting the test: a released verb may soft-fail. */
async function settlement(promise: Promise<unknown>, ms = 2_000): Promise<'resolved' | 'rejected' | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => 'resolved' as const, () => 'rejected' as const),
      new Promise<'pending'>(resolve => { timer = setTimeout(() => resolve('pending'), ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface Harness {
  readonly id: SessionId
  readonly original: ISessions
  readonly eventSource: MutableEventSource
  readonly retainCalls: Array<{ target: unknown; source: string }>
  readonly ready: Deferred<SessionBinding>
  readonly liveReferences: number
  readonly loadOlderCalls: number
  readonly loadThroughCalls: number
  resolveReady(): void
}

function harness(options: { id: SessionId; tail?: readonly SessionEventLikeEntry[]; tailHasMore?: boolean;
  ctx?: SessionBinding['ctx']; tailOutline?: readonly OutlineRow[]; loadOlder?: (events: MutableEventSource) => Promise<void> }): Harness {
  const { id } = options
  const eventSource = new runtime.MutableSessionEventSource()
  eventSource.replace(options.tail ?? [event(10)], options.tailHasMore ?? true)
  const state: SessionSnapshot = snapshotOf(id, options.tailHasMore ?? true)
  let liveReferences = 0
  let loadOlderCalls = 0
  let loadThroughCalls = 0
  const retainedBy = new Map<string, number>()
  const retainCalls: Array<{ target: unknown; source: string }> = []
  const outline = new ValueSource<readonly OutlineRow[]>(options.tailOutline ?? [])
  const otherProjection = new ValueSource<unknown>(undefined)
  const retainInfo = new ValueSource<SessionRetainInfo>({ referenceCount: 0, retainedBy: {} })
  const ready = deferred<SessionBinding>()

  const refreshRetainInfo = (): void => {
    retainInfo.set({
      referenceCount: liveReferences,
      retainedBy: Object.fromEntries(retainedBy) as SessionRetainInfo['retainedBy'],
    })
  }

  const binding: SessionBinding = {
    sessionId: id,
    eventSource,
    ctx: options.ctx ?? {} as SessionBinding['ctx'],
    session: {
      sessionId: id,
      projections: { faceOf: (key: string) => key === 'turnOutline' ? outline : otherProjection },
      getSnapshot: () => state,
      subscribe: (_listener: () => void) => () => {},
      loadOlder: () => { loadOlderCalls += 1; return options.loadOlder?.(eventSource) ?? Promise.resolve() },
      loadThrough: (_seq: SessionSeq) => { loadThroughCalls += 1; return Promise.resolve() },
    } as unknown as SessionFace,
  }

  const original = {
    retain: (target: unknown, retainOptions: SessionRetainOptions): SessionReference => {
      retainCalls.push({ target, source: retainOptions.source })
      retainedBy.set(retainOptions.source, (retainedBy.get(retainOptions.source) ?? 0) + 1)
      liveReferences += 1
      refreshRetainInfo()
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        liveReferences -= 1
        const remaining = retainedBy.get(retainOptions.source)! - 1
        if (remaining === 0) retainedBy.delete(retainOptions.source)
        else retainedBy.set(retainOptions.source, remaining)
        refreshRetainInfo()
      }
      return { sessionId: id, binding, ready: ready.promise, release } as unknown as SessionReference
    },
    retainInfo: (_id: SessionId) => retainInfo,
    binding: (requested: SessionId) => requested === id && liveReferences > 0 ? binding : undefined,
    scope: (requested: SessionId) => requested === id && liveReferences > 0 ? binding.ctx : undefined,
    scopeOf: (ctx: Context) => runtime.scopeOf(ctx),
    sessionOf: (ctx: Context) => runtime.scopeOf(ctx) === id ? binding.session : undefined,
  } as unknown as ISessions

  return {
    id, original, eventSource, retainCalls, ready,
    get liveReferences() { return liveReferences },
    get loadOlderCalls() { return loadOlderCalls },
    get loadThroughCalls() { return loadThroughCalls },
    resolveReady: () => { ready.resolve(binding) },
  }
}

test('pending loadOlder publishes loadingOlder, then publishes completion and exhaustion', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(1), tail: [event(10)], tailHasMore: true })
  h.resolveReady()
  const pageGate = deferred<{ ok: true; value: SourceHistoryWindowValue }>()
  const requested = deferred<void>()
  const requests: SourceHistoryWindowRequest[] = []
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({
    sourceHistoryWindowPage: async (request) => {
      requests.push(request)
      requested.resolve(undefined)
      return pageGate.promise
    },
  }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await within(reference.ready, 'source reference did not become ready')
    const face = reference.binding.session
    let notifications = 0
    const stop = face.subscribe(() => { notifications += 1 })
    try {
      const pending = face.loadOlder()
      await within(requested.promise, 'loadOlder did not request older source history')
      const during = face.getSnapshot()
      assert.equal(during.loadingOlder, true, 'the official snapshot must publish a pending history load')
      assert.ok(notifications > 0, 'subscribers must be notified when loadingOlder becomes true')
      const duringNotifications = notifications
      assert.equal(requests.length, 1, 'one pending loadOlder must issue one bounded source-window request')

      pageGate.resolve({ ok: true, value: windowValue([event(5), event(7)], { hasMoreBefore: false }) })
      await within(pending, 'loadOlder did not settle')

      const after = face.getSnapshot()
      assert.equal(after.loadingOlder, false, 'the official snapshot must clear loadingOlder after completion')
      assert.equal(after.hasMore, false, 'the official snapshot must publish exhausted history')
      assert.ok(notifications > duringNotifications, 'subscribers must be notified when loading completes')
      assert.deepEqual(seqs(reference.binding.eventSource.getSnapshot()), [5, 7, 10],
        'the facade window must prepend the older page without losing the loaded tail')
      assert.equal(reference.binding.eventSource.getSnapshot().hasMore, false,
        'the underlying event window must publish exhaustion')
    } finally {
      stop()
    }
  } finally {
    reference.release()
  }
})

test('cancelling loadOlder while the HAPI API is attaching clears the pending UI immediately', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(101), tail: [event(10)], tailHasMore: true })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith())
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await within(reference.ready, 'source reference did not become ready')
    facade.api = undefined
    const face = reference.binding.session as SessionFace & SourceViewportSession
    const loading = face.loadOlder()
    assert.equal(face.getSnapshot().loadingOlder, true)
    face.cancelOlderPage?.(new Error('reader stopped waiting for API attachment'))
    assert.equal(await settlement(loading, 250), 'resolved',
      'cancellation while waiting for API attachment must not leave the button loading until the 30-second attach timeout')
    assert.equal(face.getSnapshot().loadingOlder, false)
  } finally {
    reference.release()
    facade.dispose()
  }
})

test('an upward prefetch warms one older page without touching the window, then loadOlder commits that page', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(208), tail: [event(10)], tailHasMore: true })
  h.resolveReady()
  const pageGate = deferred<{ ok: true; value: SourceHistoryWindowValue }>()
  const requested = deferred<void>()
  const requests: SourceHistoryWindowRequest[] = []
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryWindowPage: async request => {
    requests.push(request)
    requested.resolve(undefined)
    return pageGate.promise
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await reference.ready
    const face = reference.binding.session as SessionFace & SourceViewportSession
    const before = reference.binding.eventSource.getSnapshot()
    const prefetch = face.prefetchOlderPage!()
    await within(requested.promise, 'upward prefetch did not warm its adjacent page')
    const duplicate = face.prefetchOlderPage!()
    assert.equal(requests.length, 1, 'repeated wheel/touch samples share the same page request')
    assert.equal(face.getSnapshot().loadingOlder, false, 'background warm-up does not expose a foreground loading state')
    assert.equal(reference.binding.eventSource.getSnapshot(), before, 'uncommitted prefetched rows stay invisible')

    pageGate.resolve({ ok: true, value: windowValue([event(5), event(7)], { hasMoreBefore: false }) })
    await within(Promise.all([prefetch, duplicate]), 'prefetched page did not finish')
    assert.equal(reference.binding.eventSource.getSnapshot(), before, 'completing the warm-up still does not publish it')

    await face.loadOlder()
    assert.equal(requests.length, 1, 'the foreground page consumes the warmed source response')
    assert.deepEqual(seqs(reference.binding.eventSource.getSnapshot()), [5, 7, 10])
    assert.equal(face.getSnapshot().hasMore, false)
  } finally { reference.release(); facade.dispose() }
})

test('a larger warm page feeds a smaller viewport read and its remainder without duplicate HAPI requests', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(212), tail: [sourceEvent('tail-100', 100)], tailHasMore: true })
  h.resolveReady()
  const requests: SourceHistoryWindowRequest[] = []
  const frames = Array.from({ length: 50 }, (_, index) => bodyFrame(`message-${index + 1}`, index + 1))
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryWindowPage: async request => {
    requests.push(request)
    return { ok: true, value: windowValue([], { frames, before: { at: 1, seq: 1 }, beforeMessageId: 'message-1',
      hasMoreBefore: true, hasMoreAfter: false, epoch: 1 }) }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await reference.ready
    const face = reference.binding.session as SessionFace & SourceViewportSession
    await face.prefetchOlderPage!(50)
    await face.loadViewportPage(20)
    assert.equal(requests.length, 1, 'the 50-row warm page satisfies the first 20-row viewport request')
    const sourceIds = (): string[] => reference.binding.eventSource.getSnapshot().entries
      .flatMap(entry => {
        const source = (entry as unknown as { source?: { messageId: string } }).source
        return source?.messageId.startsWith('message-') ? [source.messageId] : []
      })
    assert.deepEqual(sourceIds(), Array.from({ length: 20 }, (_, index) => `message-${index + 31}`))

    await face.prefetchOlderPage!(50)
    await face.loadViewportPage(20)
    assert.equal(requests.length, 1, 'the unconsumed older rows remain available at the new source cursor')
    assert.deepEqual(sourceIds(), [...Array.from({ length: 20 }, (_, index) => `message-${index + 11}`),
      ...Array.from({ length: 20 }, (_, index) => `message-${index + 31}`)])
  } finally { reference.release(); facade.dispose() }
})

test('reopening the same source reuses its cached older page without another HAPI read', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(211), tail: [event(10)], tailHasMore: true })
  h.resolveReady()
  let requests = 0
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryWindowPage: async () => {
    requests++
    return { ok: true, value: windowValue([event(5)], { hasMoreBefore: false }) }
  } }))
  const first = facade.retain(h.id, { source: 'mainView' })
  await first.ready
  try {
    await (first.binding.session as SessionFace).loadOlder()
    assert.equal(requests, 1)
  } finally { first.release() }

  const reopened = facade.retain(h.id, { source: 'mainView' })
  try {
    await reopened.ready
    await (reopened.binding.session as SessionFace).loadOlder()
    assert.equal(requests, 1, 'a released Pane does not discard an already accepted source page')
    assert.deepEqual(seqs(reopened.binding.eventSource.getSnapshot()), [5, 10])
  } finally { reopened.release(); facade.dispose() }
})

test('a failed background page warm-up stays invisible and the next foreground attempt retries its cursor', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(209), tail: [event(10)], tailHasMore: true })
  h.resolveReady()
  let requests = 0
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryWindowPage: async () => {
    requests++
    if (requests === 1) throw new Error('prefetch transport failed')
    return { ok: true, value: windowValue([event(5)], { hasMoreBefore: false }) }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await reference.ready
    const face = reference.binding.session as SessionFace & SourceViewportSession
    await face.prefetchOlderPage!()
    assert.equal(face.getSnapshot().loadingOlder, false)
    assert.equal(face.sourceWindow?.getSnapshot().pagingError, undefined,
      'a speculative read failure must not become a foreground paging error')
    assert.deepEqual(seqs(reference.binding.eventSource.getSnapshot()), [10])

    await face.loadOlder()
    assert.equal(requests, 2, 'the foreground request retries the same source cursor')
    assert.deepEqual(seqs(reference.binding.eventSource.getSnapshot()), [5, 10])
  } finally { reference.release(); facade.dispose() }
})

test('loadOlder stays in one flight while skipping raw pages with no projected rows', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(206), tail: [event(10)], tailHasMore: true })
  h.resolveReady()
  const requests: SourceHistoryWindowRequest[] = []
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryWindowPage: async request => {
    requests.push(request)
    if (requests.length === 1) return { ok: true, value: windowValue([], {
      frames: [], before: { at: 8, seq: 8 }, beforeMessageId: 'filtered-source-row', epoch: 1,
      hasMoreBefore: true, hasMoreAfter: false,
    }) }
    return { ok: true, value: windowValue([event(5)], {
      before: { at: 5, seq: 5 }, beforeMessageId: 'visible-source-row', epoch: 1,
      hasMoreBefore: false, hasMoreAfter: false,
    }) }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await reference.ready
    const face = reference.binding.session
    const changes: string[] = []
    const stop = reference.binding.eventSource.subscribe(() => {
      changes.push(reference.binding.eventSource.getSnapshot().change.kind)
    })
    try {
      await face.loadOlder()
      assert.deepEqual(requests.map(request => ({ beforeSeq: request.beforeSeq, cursorMessageId: request.cursorMessageId,
        fromOldest: request.fromOldest })), [
        { beforeSeq: undefined, cursorMessageId: undefined, fromOldest: true },
        { beforeSeq: 8, cursorMessageId: 'filtered-source-row', fromOldest: undefined },
      ], 'the second request starts at the cursor advanced by the invisible raw page')
      assert.deepEqual(changes, ['prepend'], 'the reading window publishes once, after visible rows arrive')
      assert.deepEqual(seqs(reference.binding.eventSource.getSnapshot()), [5, 10])
      assert.equal(face.getSnapshot().loadingOlder, false)
      assert.equal(face.getSnapshot().hasMore, false)
    } finally { stop() }
  } finally { reference.release(); facade.dispose() }
})

test('loadOlder rejects a page that claims more history without advancing its cursor', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(207), tail: [event(10)], tailHasMore: true })
  h.resolveReady()
  let requests = 0
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryWindowPage: async () => {
    requests++
    return { ok: true, value: windowValue([], { frames: [], before: { at: 8, seq: 8 },
      beforeMessageId: 'stalled-source-row', epoch: 1, hasMoreBefore: true, hasMoreAfter: false }) }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await reference.ready
    await assert.rejects(reference.binding.session.loadOlder(), /cursor did not advance/)
    assert.equal(requests, 2, 'a repeated cursor is detected before the same page can be requested indefinitely')
    assert.equal(reference.binding.session.getSnapshot().loadingOlder, false)
    assert.equal(reference.binding.session.getSnapshot().hasMore, true)
  } finally { reference.release(); facade.dispose() }
})

test('cancelling a stalled older page clears loading state and ignores its late response', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(208), tail: [event(10)], tailHasMore: true })
  h.resolveReady()
  const started = deferred<void>()
  const latePage = deferred<{ ok: true; value: SourceHistoryWindowValue }>()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryWindowPage: async () => {
    started.resolve(undefined)
    return latePage.promise
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await reference.ready
    const session = reference.binding.session as SessionFace & SourceViewportSession
    const entries = reference.binding.eventSource.getSnapshot().entries
    const pending = session.loadOlder()
    await within(started.promise, 'the foreground history request did not start')
    assert.equal(session.getSnapshot().loadingOlder, true)

    session.cancelOlderPage!(new Error('reader request timed out'))
    await within(pending, 'cancelling the page did not release the foreground loader')
    assert.equal(session.getSnapshot().loadingOlder, false,
      'the stale RPC cannot leave the Load earlier control permanently busy')
    assert.equal(session.sourceWindow?.getSnapshot().pagingError, undefined,
      'cancellation is not presented as a source-page failure')

    latePage.resolve({ ok: true, value: windowValue([event(5)], { hasMoreBefore: false }) })
    await Promise.resolve(); await Promise.resolve()
    assert.equal(reference.binding.eventSource.getSnapshot().entries, entries,
      'a response from the cancelled page never replaces the current reading window')
  } finally { reference.release(); facade.dispose() }
})

test('viewport admission measures its window while interactive paging delegates to the HAPI page policy', async () => {
  const h = harness({ id: sourceId(21), tail: [event(1_000)], tailHasMore: true })
  h.resolveReady()
  const requests: SourceHistoryWindowRequest[] = []
  const port = { clientHeight: 600, clientWidth: 800, scrollHeight: 600,
    querySelector(selector: string) {
      if (selector === '[data-composer-seat]') return { offsetHeight: 0 }
      if (selector === '[data-chat-flow]:not([data-step-process-content])') return {
        getBoundingClientRect: () => ({ height: port.scrollHeight }),
      }
      return null
    },
  }
  const input = { getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 700, height: 50 }),
    getAttribute: (name: string) => name === 'contenteditable' ? 'true' : null,
    hasAttribute: () => false, closest: () => null }
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryWindowPage: async request => {
    requests.push(request)
    const first = 1_000 - requests.length * 20
    if (requests.length === 3) port.scrollHeight = 900
    return { ok: true, value: windowValue(Array.from({ length: 20 }, (_, index) => event(first + index)), {
      before: { at: first, seq: first }, hasMoreBefore: true, hasMoreAfter: false,
    }) }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await reference.ready
    const target = {
      ownerDocument: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
        defaultView: { performance, requestAnimationFrame(callback: FrameRequestCallback) {
          queueMicrotask(() => callback(performance.now())); return 1
        }, cancelAnimationFrame() {} } },
      querySelector: () => port, getAttribute: () => null,
      querySelectorAll: () => [input],
    } as unknown as HTMLElement
    const navigation = { reading: { getSnapshot: () => undefined },
      state: { getSnapshot: () => ({ visible: true }), subscribe: () => () => {} } } as unknown as WorkspacePaneNavigation
    assert.equal(await prepareInitialViewport(target, reference, navigation, () => true), true)
    assert.equal(requests.length, 3, 'source progress alone cannot expose a viewport without actual scroll range')
    assert.deepEqual(requests.map(request => request.limit), [20, 50, 50])
    assert.equal(requests[0]!.fromOldest, true)
    assert.deepEqual(requests.slice(1).map(request => request.beforeSeq), [980, 960])
    assert.equal(reference.binding.eventSource.getSnapshot().entries.length, 61)
    await reference.binding.session.loadOlder()
    assert.equal(requests[3]!.limit, 50,
      'interactive history uses HAPI regular page budget to bound DSH event fan-out')
    assert.equal(requests[3]!.beforeSeq, 940, 'the first interactive page continues the admitted window')
    assert.ok(h.loadOlderCalls <= 1, 'ordinary interactive paging delegates at most one official attempt before the facade mirrors it')
    assert.equal(typeof (reference.binding.session as SessionFace & SourceViewportSession).loadViewportPage, 'function')
  } finally { reference.release(); facade.dispose() }
})

test('retain preserves the caller mainView source through original retention and retainInfo', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(2) })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith())
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await within(reference.ready, 'source reference did not become ready')
    assert.deepEqual(h.retainCalls.map(call => call.source), ['mainView'],
      'original retention must preserve the caller source, not substitute hapiWorkspace')
    assert.deepEqual(facade.retainInfo(h.id).getSnapshot().retainedBy, { mainView: 1 },
      'public retainInfo accounting must report the caller mainView reference')
  } finally {
    reference.release()
  }
})

test('a visible mainView retains its identity after a background owner opens the source first', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(11) })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith())
  const background = facade.retain(h.id, { source: 'hapiWorkspace' as SessionRetainOptions['source'] })
  const visible = facade.retain(h.id, { source: 'mainView' })
  try {
    await Promise.all([background.ready, visible.ready])
    assert.equal(background.binding, visible.binding, 'different owners share the same source binding')
    assert.deepEqual(facade.retainInfo(h.id).getSnapshot().retainedBy, { hapiWorkspace: 1, mainView: 1 },
      'visible mainView ownership cannot disappear behind the first background reference')
    background.release()
    assert.deepEqual(facade.retainInfo(h.id).getSnapshot().retainedBy, { mainView: 1 },
      'releasing the background owner must leave exactly the visible owner')
    assert.equal(facade.binding(h.id), visible.binding)
  } finally {
    background.release()
    visible.release()
  }
})

test('two references to one source share a binding and release the original only after the last owner', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(3) })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith())
  const first = facade.retain(h.id, { source: 'mainView' })
  const second = facade.retain(h.id, { source: 'mainView' })
  try {
    const [firstBinding, secondBinding] = await Promise.all([
      within(first.ready, 'first source reference did not become ready'),
      within(second.ready, 'second source reference did not become ready'),
    ])
    assert.equal(firstBinding, secondBinding, 'same-source references must share one stable binding')
    assert.equal(facade.binding(h.id), firstBinding, 'the facade must expose the shared live binding')
    first.release()
    first.release()
    assert.equal(h.liveReferences, 1, 'releasing one of two references must keep one original lease alive')
    assert.equal(facade.binding(h.id), firstBinding, 'the remaining reference must keep the binding live')
    second.release()
    assert.equal(h.liveReferences, 0, 'the final release must leave no original lease behind')
    assert.equal(facade.binding(h.id), undefined, 'no binding remains after the final release')
  } finally {
    first.release()
    second.release()
  }
})

test('preparation and public ready open the same binding while a slow outline remains independent', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(70) })
  const outlineEntered = deferred<void>(), outlineGate = deferred<void>()
  const facade = new runtime.SourceSessions(h.original)
  let outlineCalls = 0
  facade.attach(apiWith({ sourceHistoryOutline: async () => {
    outlineCalls++
    outlineEntered.resolve(undefined)
    await outlineGate.promise
    return { ok: true, value: outlineValue([{ turn: 0, seq: 5, prompt: 'complete', response: 'complete' }]) }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' }) as SourcePreparationReference
  const preparationOutcomes: string[] = [], readyOutcomes: string[] = []
  void reference.preparationReady.then(() => preparationOutcomes.push('resolved'), () => preparationOutcomes.push('rejected'))
  void reference.ready.then(() => readyOutcomes.push('resolved'), () => readyOutcomes.push('rejected'))
  try {
    await within(outlineEntered.promise, 'outline did not start while the original reference was still pending')
    assert.deepEqual(preparationOutcomes, [], 'preparation must wait for the original reference')
    assert.deepEqual(readyOutcomes, [])
    h.resolveReady()
    const prepared = await within(reference.preparationReady, 'the slow outline blocked hidden preparation')
    assert.equal(prepared, reference.binding)
    assert.equal(facade.binding(h.id), prepared)
    assert.equal(await within(reference.ready, 'the slow outline blocked the body'), prepared)
    assert.equal(outlineStateOf(prepared).getSnapshot().status, 'none', 'body readiness must not report pending navigation as complete')
    assert.deepEqual(outlineRowsOf(prepared), [])
    assert.deepEqual(h.retainCalls, [{ target: h.id, source: 'mainView' }])
    assert.equal(h.liveReferences, 1, 'preparation must use the caller existing original lease')
    outlineGate.resolve(undefined)
    await waitForOutline(prepared, 'ready')
    assert.equal(await reference.ready, prepared)
    assert.equal(outlineCalls, 1)
    assert.deepEqual(outlineRowsOf(prepared).map(row => row.prompt), ['complete'])
    assert.equal(h.retainCalls.length, 1)
  } finally { outlineGate.resolve(undefined); reference.release(); facade.dispose() }
})

test('each preparation waits for its own original reference while sharing the source binding', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(71) })
  const firstOriginal = deferred<SessionBinding>(), secondOriginal = deferred<SessionBinding>()
  const originalBindings: SessionBinding[] = []
  const original: ISessions = { ...h.original, retain(target, options) {
    const reference = h.original.retain(target, options)
    originalBindings.push(reference.binding)
    return { ...reference, ready: originalBindings.length === 1 ? firstOriginal.promise : secondOriginal.promise }
  } }
  const facade = new runtime.SourceSessions(original)
  facade.attach(apiWith())
  const first = facade.retain(h.id, { source: 'mainView' }) as SourcePreparationReference
  const second = facade.retain(h.id, { source: 'hapiWorkspace' }) as SourcePreparationReference
  const secondOutcomes: string[] = []
  void second.preparationReady.then(() => secondOutcomes.push('resolved'), () => secondOutcomes.push('rejected'))
  try {
    firstOriginal.resolve(originalBindings[0]!)
    const binding = await within(first.preparationReady, 'first caller preparation never settled')
    assert.equal(await first.ready, binding)
    assert.deepEqual(secondOutcomes, [], 'one open original reference must not admit another caller')
    secondOriginal.resolve(originalBindings[1]!)
    assert.equal(await within(second.preparationReady, 'second caller preparation never settled'), binding)
    assert.equal(await second.ready, binding)
    assert.deepEqual(h.retainCalls.map(call => call.source), ['mainView', 'hapiWorkspace'])
  } finally { first.release(); second.release(); facade.dispose() }
})

test('preparation propagates an original reference failure without waiting for the outline', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(72) })
  const outlineEntered = deferred<void>(), outlineGate = deferred<void>()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryOutline: async () => {
    outlineEntered.resolve(undefined)
    await outlineGate.promise
    return { ok: true, value: outlineValue([]) }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' }) as SourcePreparationReference
  const failure = new Error('the caller original session could not open')
  const preparationFailed = assert.rejects(reference.preparationReady, error => error === failure)
  const readyFailed = assert.rejects(reference.ready, error => error === failure)
  try {
    await within(outlineEntered.promise, 'outline request never started')
    h.ready.reject(failure)
    await within(Promise.all([preparationFailed, readyFailed]), 'original failure waited for the slow outline')
    assert.equal(h.retainCalls.length, 1)
  } finally { outlineGate.resolve(undefined); reference.release(); facade.dispose() }
})

test('the final release cancels pending preparation and late completion cannot restore it', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(73), tailOutline: [{ turn: 1, seq: 10, prompt: 'tail', response: 'tail' }] })
  const outlineEntered = deferred<void>(), outlineGate = deferred<void>()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryOutline: async () => {
    outlineEntered.resolve(undefined)
    await outlineGate.promise
    return { ok: true, value: outlineValue([{ turn: 0, seq: 5, prompt: 'late host', response: 'late host' }]) }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' }) as SourcePreparationReference
  const binding = reference.binding, before = outlineRowsOf(binding)
  const outcomes: string[] = []
  void reference.preparationReady.then(() => outcomes.push('resolved'), () => outcomes.push('rejected'))
  const preparationCancelled = assert.rejects(reference.preparationReady, /released/)
  const readyCancelled = assert.rejects(reference.ready, /released/)
  try {
    await within(outlineEntered.promise, 'outline request never started')
    reference.release()
    await within(Promise.all([preparationCancelled, readyCancelled]), 'release waited for the original open to finish')
    assert.equal(h.liveReferences, 0)
    assert.equal(facade.binding(h.id), undefined)
    h.resolveReady()
    outlineGate.resolve(undefined)
    await h.ready.promise
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(outcomes, ['rejected'], 'a late original completion must not restore cancelled preparation')
    assert.equal(facade.binding(h.id), undefined)
    assert.equal(outlineRowsOf(binding), before, 'a late outline must not publish into the retired binding')
    assert.equal(h.retainCalls.length, 1)
    assert.equal(h.liveReferences, 0)
  } finally { outlineGate.resolve(undefined); reference.release(); facade.dispose() }
})

test('ordinary sessions return the original reference without source preparation', { timeout: 5_000 }, async () => {
  const h = harness({ id: 'ordinary-session' as SessionId })
  let delegated: SessionReference | undefined
  const original: ISessions = { ...h.original, retain(target, options) {
    delegated = h.original.retain(target, options)
    return delegated
  } }
  const facade = new runtime.SourceSessions(original)
  let outlineCalls = 0
  facade.attach(apiWith({ sourceHistoryOutline: async () => {
    outlineCalls++
    return { ok: true, value: outlineValue([]) }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    assert.equal(reference, delegated, 'ordinary sessions must retain the original reference identity')
    assert.equal(reference.ready, h.ready.promise)
    assert.equal('preparationReady' in reference, false)
    h.resolveReady()
    assert.equal(await reference.ready, reference.binding)
    assert.equal(outlineCalls, 0)
    assert.deepEqual(h.retainCalls, [{ target: h.id, source: 'mainView' }])
  } finally { reference.release(); facade.dispose() }
  assert.equal(h.liveReferences, 0)
})

test('body ready precedes the source-wide outline and navigation later exposes merged host/tail turns', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(4), tailOutline: [{ turn: 1, seq: 10, prompt: 'tail-duplicate', response: 'tail' }] })
  h.resolveReady()
  const outlineGate = deferred<void>()
  const calls: string[] = []
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({
    sourceHistoryOutline: async (request) => {
      calls.push(request.sessionId)
      await outlineGate.promise
      return { ok: true, value: outlineValue([
        { turn: 0, seq: 5, prompt: 'host-zero', response: 'zero' },
        { turn: 1, seq: 10, prompt: 'host-one', response: 'one' },
        { turn: 2, seq: 20, prompt: 'host-two', response: 'two' },
      ]) }
    },
  }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    const binding = await within(reference.ready, 'pending navigation blocked the source body')
    assert.equal(outlineStateOf(binding).getSnapshot().status, 'none')
    assert.deepEqual(outlineRowsOf(binding).map(row => row.prompt), ['tail-duplicate'])
    outlineGate.resolve(undefined)
    await waitForOutline(binding, 'ready')
    assert.deepEqual(calls, [h.id], 'the facade must prefetch the outline once for this source')
    assert.deepEqual(outlineRowsOf(binding).map(entry => entry.turn), [0, 1, 2],
      'the projection must expose the source-wide turn ladder in order')
    assert.equal(outlineRowsOf(binding)[1]?.prompt, 'host-one',
      'the host outline must win over a duplicate loaded-tail turn')
    assert.equal(binding, reference.binding, 'ready must resolve the same stable binding')
  } finally {
    outlineGate.resolve(undefined); reference.release(); facade.dispose()
  }
})

test('a late source API attach backfills navigation without delaying the loaded body', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(5), tailOutline: [{ turn: 1, seq: 10, prompt: 'tail-only', response: 'tail' }] })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    const binding = await within(reference.ready, 'the absent metadata API blocked the loaded body')
    assert.equal(binding, reference.binding)
    assert.equal(outlineStateOf(binding).getSnapshot().status, 'none')
    assert.deepEqual(outlineRowsOf(binding).map(row => row.prompt), ['tail-only'])

    facade.attach(apiWith({
      sourceHistoryOutline: async () => ({ ok: true, value: outlineValue([
        { turn: 0, seq: 5, prompt: 'host-zero', response: 'zero' },
        { turn: 1, seq: 10, prompt: 'host-one', response: 'one' },
      ]) }),
    }))
    await waitForOutline(binding, 'ready')
    assert.equal(await reference.ready, binding, 'late metadata cannot replace the body binding')
    assert.deepEqual(outlineRowsOf(binding).map(entry => entry.turn), [0, 1],
      'a late attach must backfill the source-wide outline instead of painting the loaded tail as full')
  } finally {
    reference.release(); facade.dispose()
  }
})

test('cold indexing admits the first body and completes the directory in the background', { timeout: 8_000 }, async () => {
  const h = harness({ id: sourceId(62), tailOutline: [{ turn: 1, seq: 10, prompt: 'tail-only', response: 'tail' }] })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  const fourth = deferred<void>(), complete = deferred<void>()
  let calls = 0
  const full = outlineValue([
    { turn: 0, seq: 5, prompt: 'host-zero', response: 'zero' },
    { turn: 1, seq: 10, prompt: 'host-one', response: 'one' },
  ])
  facade.attach(apiWith({ sourceHistoryOutline: async () => {
    if (++calls <= 3) return { ok: true, value: { ...full, complete: false, indexing: true,
      scannedThrough: calls, headSeq: 4 } }
    fourth.resolve(undefined)
    await complete.promise
    return { ok: true, value: { ...full, complete: true, indexing: false, scannedThrough: 4, headSeq: 4 } }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  const binding = reference.binding
  try {
    // The first page is an indexing reply: the body is admitted, navigation is partial.
    assert.equal(await within(reference.ready, 'indexing blocked the first body'), binding)
    assert.deepEqual(outlineRowsOf(binding).map(row => row.prompt), ['tail-only'],
      'a provisional host outline must not replace the loaded tail yet')
    assert.equal(h.retainCalls.length, 1, 'indexing recovery must not acquire another native lease')
    await within(fourth.promise, 'the background scan did not continue after indexing')
    assert.equal(outlineStateOf(binding).getSnapshot().status, 'partial')
    complete.resolve(undefined)
    await waitForOutline(binding, 'ready')
    assert.deepEqual(outlineRowsOf(binding).map(row => row.prompt), ['host-zero', 'host-one'],
      'the completed directory must replace the provisional preview')
    assert.deepEqual(seqs(binding.eventSource.getSnapshot()), [10], 'indexing must not reread or replace the body window')
    assert.equal(h.loadOlderCalls, 0)
    assert.equal(h.loadThroughCalls, 0)
    assert.equal(calls, 4)
  } finally { complete.resolve(undefined); reference.release(); facade.dispose() }
})

for (const state of ['unreadable', 'incomplete'] as const) {
  test(`a permanently ${state} outline degrades navigation without failing the open`, async () => {
    const h = harness({ id: sourceId(state === 'unreadable' ? 63 : 64) })
    h.resolveReady()
    const facade = new runtime.SourceSessions(h.original)
    let calls = 0
    facade.attach(apiWith({ sourceHistoryOutline: async () => {
      calls++
      return { ok: true, value: { ...outlineValue([]), complete: false,
        indexing: state === 'unreadable', unreadable: state === 'unreadable' } }
    } }))
    const reference = facade.retain(h.id, { source: 'mainView' })
    try {
      // A directory failure is a navigation state, not an open failure.
      assert.equal(await within(reference.ready, 'a directory failure blocked the open'), reference.binding)
      await waitForOutline(reference.binding, 'degraded')
      assert.deepEqual(seqs(reference.binding.eventSource.getSnapshot()), [10],
        'the body window stays exactly as loaded')
      assert.ok(calls >= 1)
    } finally { reference.release(); facade.dispose() }
  })
}

for (const stage of ['attach', 'rpc', 'indexing'] as const) {
test(`releasing the last cold occurrence cancels background ${stage} work and ignores late completion`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness({ id: sourceId(stage === 'attach' ? 65 : stage === 'rpc' ? 66 : 67) })
    if (stage !== 'attach') h.resolveReady()
    const facade = new runtime.SourceSessions(h.original)
    const entered = deferred<void>(), reply = deferred<void>()
    let calls = 0
    const api = apiWith({ sourceHistoryOutline: async () => {
      calls++
      entered.resolve(undefined)
      if (stage === 'rpc') await reply.promise
      return { ok: true, value: { ...outlineValue([{ turn: 0, seq: 5, prompt: 'late', response: 'late' }]),
        complete: stage !== 'indexing', indexing: stage === 'indexing' } }
    } })
    if (stage !== 'attach') facade.attach(api)
    const reference = facade.retain(h.id, { source: 'mainView' }), binding = reference.binding
    let changes = 0
    const stop = binding.session.projections.faceOf('turnOutline').subscribe(() => { changes++ })
    try {
      if (stage !== 'attach') await within(entered.promise, 'the cold request never started')
      if (stage !== 'attach') assert.equal(await reference.ready, binding, 'background metadata must not delay body readiness')
      reference.release()
      if (stage === 'attach') await assert.rejects(reference.ready, /released/)
      else assert.equal(await reference.ready, binding, 'release cannot retroactively reject settled body readiness')
      assert.equal(h.liveReferences, 0)
      reply.resolve(undefined)
      if (stage === 'attach') { facade.attach(api); h.resolveReady() }
      await new Promise(resolve => setImmediate(resolve))
      t.mock.timers.tick(450)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(calls, stage === 'attach' ? 0 : 1, 'release must stop scheduled reads')
      assert.equal(changes, 0, 'late metadata cannot publish into the released occurrence')
      assert.equal(facade.binding(h.id), undefined)
    } finally { reply.resolve(undefined); stop(); reference.release(); facade.dispose(); t.mock.timers.reset() }
  })
}

test('a stalled first directory page is bounded and degrades navigation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(console, 'warn', () => {})
  const h = harness({ id: sourceId(68) }); h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  const entered = deferred<void>(), reply = deferred<void>()
  let calls = 0
  facade.attach(apiWith({ sourceHistoryOutline: async () => {
    calls++; entered.resolve(undefined); await reply.promise
    return { ok: true, value: { ...outlineValue([]), complete: true } }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await entered.promise
    assert.equal(await reference.ready, reference.binding, 'a stalled page must not consume the body readiness budget')
    assert.equal(outlineStateOf(reference.binding).getSnapshot().status, 'none')
    const degraded = waitForOutline(reference.binding, 'degraded', 6_000)
    t.mock.timers.tick(5_000)
    await degraded
    assert.equal(await reference.ready, reference.binding)
    assert.equal(calls, 1, 'the stalled page is not retried in a new loop')
    assert.deepEqual(outlineRowsOf(reference.binding), [])
  } finally { reply.resolve(undefined); reference.release(); facade.dispose(); t.mock.timers.reset() }
})

test('a complete first directory page does not schedule a redundant full re-read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(console, 'warn', () => {})
  const h = harness({ id: sourceId(69) }); h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  const full = outlineValue([{ turn: 0, seq: 5, prompt: 'complete', response: 'complete' }])
  let calls = 0
  facade.attach(apiWith({ sourceHistoryOutline: async () => {
    calls++
    return { ok: true, value: { ...full, complete: true } }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    const binding = await reference.ready
    await waitForOutline(binding, 'ready')
    const before = outlineRowsOf(binding)
    t.mock.timers.tick(20_000)
    await Promise.resolve(); await Promise.resolve()
    assert.equal(calls, 1, 'a complete directory is not re-scanned on a timer')
    assert.equal(await reference.ready, binding)
    assert.equal(outlineRowsOf(binding), before, 'the published ladder stays stable')
    assert.deepEqual(seqs(binding.eventSource.getSnapshot()), [10])
    assert.equal(h.retainCalls.length, 1)
  } finally { reference.release(); facade.dispose(); t.mock.timers.reset() }
})

test('an outline RPC failure degrades navigation instead of failing the open', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(6), tailOutline: [{ turn: 1, seq: 10, prompt: 'tail-only', response: 'tail' }] })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  const failure = new Error('The original source outline changed epoch; reopen the conversation')
  const warn = console.warn
  console.warn = () => {}
  facade.attach(apiWith({ sourceHistoryOutline: async () => ({ ok: false, error: failure }) }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    const binding = await within(reference.ready, 'a directory failure blocked the open', 4_000)
    assert.equal(binding, reference.binding, 'a directory failure must not fail the open')
    await waitForOutline(binding, 'degraded')
    assert.deepEqual(seqs(binding.eventSource.getSnapshot()), [10], 'the body window stays exactly as loaded')
  } finally { console.warn = warn; reference.release(); facade.dispose() }
})

test('a new retain retries a degraded directory while another reference keeps the same binding', { timeout: 8_000 }, async () => {
  const h = harness({ id: sourceId(61), tailOutline: [{ turn: 1, seq: 10, prompt: 'tail-only', response: 'tail' }] })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  const failure = new Error('The original source outline changed epoch; reopen the conversation')
  let available = false, calls = 0
  const warn = console.warn
  console.warn = () => {}
  facade.attach(apiWith({ sourceHistoryOutline: async () => {
    calls++
    return available ? { ok: true, value: outlineValue([
      { turn: 0, seq: 5, prompt: 'host-zero', response: 'zero' },
      { turn: 1, seq: 10, prompt: 'host-one', response: 'one' },
    ]) } : { ok: false, error: failure }
  } }))
  const first = facade.retain(h.id, { source: 'mainView' })
  const kept = facade.retain(h.id, { source: 'hapiWorkspace' })
  const binding = first.binding
  let retry: SessionReference | undefined, later: SessionReference | undefined
  try {
    // Both references share one bounded attempt; a directory failure keeps the
    // open alive and only degrades navigation.
    assert.equal(await within(first.ready, 'the degraded open never settled'), binding)
    assert.equal(await within(kept.ready, 'the shared degraded open never settled'), binding)
    await waitForOutline(binding, 'degraded')
    assert.equal(calls, 3, 'concurrent references must share one bounded failed attempt')
    first.release()
    assert.equal(h.liveReferences, 1, 'another reference must keep the degraded source record alive')
    assert.equal(facade.binding(h.id), binding)

    available = true
    retry = facade.retain(h.id, { source: 'mainView' })
    assert.equal(await within(retry.ready, 'a metadata retry blocked body readiness'), binding)
    await waitForOutline(binding, 'ready')
    assert.equal(kept.binding, binding, 'recovery must preserve the existing binding and editor owner')
    assert.equal(calls, 4, 'the new retain must issue a fresh directory read')
    assert.deepEqual(outlineRowsOf(binding).map(row => row.prompt), ['host-zero', 'host-one'])
    assert.deepEqual(seqs(binding.eventSource.getSnapshot()), [10], 'directory recovery must preserve the body window')

    later = facade.retain(h.id, { source: 'hapiWorkspace' })
    assert.equal(await later.ready, binding)
    assert.equal(calls, 4, 'a successful directory must remain shared across later retains')
  } finally {
    console.warn = warn
    first.release(); kept.release(); retry?.release(); later?.release(); facade.dispose()
  }
})

test('a source window response settling after release cannot mutate the retained window', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(7) })
  h.resolveReady()
  const pageGate = deferred<{ ok: true; value: SourceHistoryWindowValue }>()
  const requested = deferred<void>()
  const pageCalls: string[] = []
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({
    sourceHistoryOutline: async () => ({ ok: true, value: outlineValue([
      { turn: 0, seq: 5, prompt: 'host', response: 'host' },
      { turn: 9, seq: 99, prompt: 'later-host', response: 'later' },
    ]) }),
    sourceHistoryWindowPage: async (request) => {
      pageCalls.push(request.sessionId)
      requested.resolve(undefined)
      return pageGate.promise
    },
  }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await within(reference.ready, 'source reference did not become ready')
    // Retain the exposed event source before release; the released binding is
    // not a supported access path, but the source object still owns the window.
    const eventSource = reference.binding.eventSource
    const before = eventSource.getSnapshot()
    const load = reference.binding.session.loadThrough(5 as SessionSeq)
    await within(requested.promise, 'loadThrough did not issue its direct source window request')
    assert.deepEqual(pageCalls, [h.id], 'loadThrough must issue its direct source window request')
    reference.release()
    pageGate.resolve({ ok: true, value: windowValue([event(3), event(4), event(5)]) })
    await within(load, 'the released loadThrough did not settle')
    const after = eventSource.getSnapshot()
    assert.equal(after.revision, before.revision, 'a late response must not publish a new facade window')
    assert.deepEqual(seqs(after), seqs(before), 'a late response must not replace the released window')
    assert.equal(facade.binding(h.id), undefined, 'the released source must not return to the live binding map')
  } finally {
    reference.release()
  }
})

test('a target window holds the reader position while live tail advances', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(8) })
  h.resolveReady()
  const requests: SourceHistoryWindowRequest[] = []
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({
    sourceHistoryOutline: async () => ({ ok: true, value: outlineValue([
      { turn: 0, seq: 5, prompt: 'target', response: 'target' },
      { turn: 9, seq: 99, prompt: 'later-host', response: 'later' },
    ]) }),
    sourceHistoryWindowPage: async (request) => {
      requests.push(request)
      return { ok: true, value: windowValue([event(3), event(4), event(5)]) }
    },
  }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await within(reference.ready, 'source reference did not become ready')
    await within(reference.binding.session.loadThrough(5 as SessionSeq), 'target window did not load')
    assert.equal(requests.length, 1, 'the target must be read as one bounded message-context window')
    assert.equal(requests[0]?.messageId, 'message-5', 'the target must use the host outline message identity')
    const radius = requests[0]?.radius
    assert.ok(typeof radius === 'number' && radius > 0 && radius <= 99,
      'the target radius must be a positive HAPI-bounded context size (maximum 99)')
    assert.equal(requests[0]?.startSeq, undefined, 'source context reads must not allocate display coordinates on the Host')
    const target = reference.binding.eventSource.getSnapshot()
    assert.deepEqual(seqs(target), [3, 4, 5], 'the facade window must contain the direct target records')
    assert.equal(target.hasMore, true, 'the target window must publish its own older-history state')

    h.eventSource.append(event(11, 'assistant/message'))
    const afterLive = reference.binding.eventSource.getSnapshot()
    assert.equal(afterLive.revision, target.revision, 'live tail data must not steal the target reader position')
    assert.deepEqual(seqs(afterLive), [3, 4, 5], 'live tail data must not replace the target window')

    // Pinned-contract gap: the public `SessionFace`/`ISessions` type still exposes
    // no return-latest verb. The concrete product face now has an extra
    // `returnToLive()` method, but this test does not bind to that unpinned
    // extension. Return-latest/live-rejoin therefore remains unverified here.
  } finally {
    reference.release()
  }
})

test('a rejected tail loadOlder after release does not fall back to the original pager or mutate the window', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(9), tail: [event(10)], tailHasMore: true })
  h.resolveReady()
  const pageGate = deferred<never>()
  const requested = deferred<void>()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({
    sourceHistoryWindowPage: async () => {
      requested.resolve(undefined)
      return pageGate.promise
    },
  }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await within(reference.ready, 'source reference did not become ready')
    const eventSource = reference.binding.eventSource
    const before = eventSource.getSnapshot()
    const load = reference.binding.session.loadOlder()
    await within(requested.promise, 'tail loadOlder did not issue its source-window request')
    assert.equal(reference.binding.session.getSnapshot().loadingOlder, true,
      'the source-window request must be visibly pending before release')

    reference.release()
    pageGate.reject(new Error('the source-window request failed after release'))
    const outcome = await settlement(load)
    assert.notEqual(outcome, 'pending', 'the released tail loadOlder did not settle')

    assert.equal(h.loadOlderCalls, 0,
      'a rejected post-release source window must not fall back to originalFace.loadOlder')
    const after = eventSource.getSnapshot()
    assert.equal(after.revision, before.revision, 'the fallback must not republish the released window')
    assert.deepEqual(seqs(after), seqs(before), 'the fallback must not replace the released window with the original tail')
    assert.equal(after.hasMore, before.hasMore, 'the fallback must not restore the original window history state')
    assert.equal(facade.binding(h.id), undefined, 'the released source must not return to the live binding map')
  } finally {
    reference.release()
  }
})

test('a released non-host loadThrough resolving no anchor does not fall back to the original pager or showTail', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(10) })
  h.resolveReady()
  const anchorGate = deferred<{ ok: true; value: { sourceMessageId: null } }>()
  const anchorRequested = deferred<void>()
  const anchorSeqs: number[] = []
  const windowRequests: SourceHistoryWindowRequest[] = []
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({
    sourceHistoryOutline: async () => ({ ok: true, value: outlineValue([
      { turn: 0, seq: 5, prompt: 'host', response: 'host' },
      { turn: 9, seq: 99, prompt: 'later-host', response: 'later' },
    ]) }),
    sourceHistoryWindowPage: async (request) => {
      windowRequests.push(request)
      return { ok: true, value: windowValue([event(3), event(4), event(5)]) }
    },
    // Public optional seam. If it disappears, this case fails at the anchor
    // wait instead of silently skipping the branch or inventing a private hook.
    sourceReadingAnchor: async (request) => {
      anchorSeqs.push(request.seq)
      anchorRequested.resolve(undefined)
      return anchorGate.promise
    },
  }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await within(reference.ready, 'source reference did not become ready')
    // Enter target mode first: an erroneous showTail fallback would then be
    // visible as a new revision and a replacement with the original tail.
    await within(reference.binding.session.loadThrough(5 as SessionSeq), 'target window did not load')
    assert.equal(windowRequests.length, 1, 'the target must issue one bounded window request')
    const eventSource = reference.binding.eventSource
    const before = eventSource.getSnapshot()
    assert.deepEqual(seqs(before), [3, 4, 5], 'the target window must be resident before the non-host jump')

    const load = reference.binding.session.loadThrough(42 as SessionSeq)
    await within(anchorRequested.promise, 'non-host loadThrough did not request a reading anchor')
    assert.deepEqual(anchorSeqs, [42], 'the non-host jump must wait on the public sourceReadingAnchor seam')
    reference.release()
    anchorGate.resolve({ ok: true, value: { sourceMessageId: null } })
    const outcome = await settlement(load)
    assert.notEqual(outcome, 'pending', 'the released non-host loadThrough did not settle')

    assert.equal(h.loadThroughCalls, 0,
      'a released null anchor must not fall back to originalFace.loadThrough')
    assert.equal(windowRequests.length, 1, 'the released anchor path must not request another source window')
    const after = eventSource.getSnapshot()
    assert.equal(after.revision, before.revision, 'the fallback must not call showTail or republish the released window')
    assert.deepEqual(seqs(after), seqs(before), 'the fallback must not replace target data with the original tail')
    assert.equal(after.hasMore, before.hasMore, 'the fallback must not restore the original tail history state')
    assert.equal(facade.binding(h.id), undefined, 'the released source must not return to the live binding map')
  } finally {
    reference.release()
  }
})

function frameTransport(frames: SourceFrame[], kind: 'replace' | 'merge' = 'replace', seq = 0): SessionEventLikeEntry {
  return { type: 'event', event: { type: SOURCE_FRAME_EVENT, seq, time: seq, data: { kind, frames } } } as unknown as SessionEventLikeEntry
}

function bodyFrame(id: string, ordinal: number): SourceFrame {
  return { key: `body:${id}`, source: { messageId: id, at: ordinal, seq: ordinal }, turnKey: `turn:${id}`, stepKey: `step:${id}`,
    event: { type: 'assistant/message', seq: 0, time: ordinal, data: { turn: 1, step: 1,
      message: { id, role: 'assistant', content: [{ type: 'text', text: id }] } } } as unknown as SourceFrame['event'] }
}

function bodyStream() {
  const queue: SourceFrameBatch[] = []
  let pending: ((value: IteratorResult<SourceFrameBatch>) => void) | undefined, closed = false, disposals = 0
  const stream = {
    [Symbol.asyncIterator]() { return this },
    next(): Promise<IteratorResult<SourceFrameBatch>> {
      const value = queue.shift()
      if (value) return Promise.resolve({ done: false, value })
      if (closed) return Promise.resolve({ done: true, value: undefined })
      return new Promise(resolve => { pending = resolve })
    },
    push(value: SourceFrameBatch) {
      if (closed) return
      if (pending) { const resolve = pending; pending = undefined; resolve({ done: false, value }) }
      else queue.push(value)
    },
    close() { closed = true; pending?.({ done: true, value: undefined }); pending = undefined },
    dispose() { disposals++; this.close() },
    get disposals() { return disposals },
  }
  return stream
}
const bodyTick = () => new Promise<void>(resolve => setImmediate(resolve))

test('source body readiness waits for its independent baseline and release cancels only that feed', async () => {
  const h = harness({ id: sourceId(201), tail: [] }), stream = bodyStream()
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceWindowFollow: () => stream }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  let ready = false
  void reference.ready.then(() => { ready = true })
  try {
    await bodyTick()
    assert.equal(ready, false, 'the operation Session opening alone is not body readiness')
    stream.push({ kind: 'replace', historyVersion: 1, frames: [bodyFrame('first', 1)] })
    await reference.ready
    assert.equal(reference.binding.session.getSnapshot().blank, false)
    assert.equal(reference.binding.eventSource.getSnapshot().entries.length, 1)
    assert.equal(h.retainCalls.length, 1)
    reference.release()
    await bodyTick()
    assert.ok(stream.disposals > 0, 'release must cancel a waiting body stream iterator')
    assert.equal(h.liveReferences, 0)
  } finally { reference.release(); facade.dispose() }
})

test('live projection state does not replace the independent transcript body window', async () => {
  const h = harness({ id: sourceId(204), tail: [event(1, 'plugin:hapi-dsh/execution')] }), stream = bodyStream()
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceWindowFollow: () => stream }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  stream.push({ kind: 'replace', historyVersion: 1, frames: [bodyFrame('tail', 1)] })
  try {
    await reference.ready
    const before = reference.binding.eventSource.getSnapshot()
    h.eventSource.append(event(2, 'plugin:hapi-dsh/execution'))
    await bodyTick()
    const after = reference.binding.eventSource.getSnapshot()
    assert.equal(after.revision, before.revision,
      'projection updates are delivered by the original session face and must not rebuild the transcript')
    assert.deepEqual(after.entries.map(entry => entry.event.type).sort(),
      ['assistant/message', 'plugin:hapi-dsh/execution'].sort(),
      'the opening projection snapshot remains available without replaying each later state update')
  } finally { reference.release(); facade.dispose() }
})

test('interactive source history commits one chunked HAPI page only after completion', { timeout: 5_000 }, async t => {
  const h = harness({ id: sourceId(205), tail: [] }), stream = bodyStream()
  h.resolveReady()
  const secondChunk = deferred<void>(), continueStream = deferred<void>()
  const allChunksRead = deferred<void>(), completePage = deferred<void>()
  const requests: SourceHistoryWindowRequest[] = []
  const allFrames = Array.from({ length: 50 }, (_, index) => {
    const ordinal = 801 + index, base = bodyFrame(`message-${ordinal}`, ordinal)
    return Array.from({ length: 4 }, (_, part) => ({ ...base, key: `${base.key}:part-${part}`,
      event: { ...base.event, seq: part } }))
  }).flat()
  const page = { before: { at: 801, seq: 801 }, after: null, beforeMessageId: 'message-801', epoch: 1,
    hasMoreBefore: true, hasMoreAfter: false } as const
  let chunks = 0
  const changeKinds: string[] = []
  let unsubscribe = (): void => {}
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceWindowFollow: () => stream, sourceHistoryWindowPageStream: async function* (request) {
    requests.push(request)
    for (let end = allFrames.length; end > 0;) {
      const start = Math.max(0, end - SOURCE_HISTORY_FRAME_CHUNK_SIZE)
      chunks++
      if (chunks === 2) { secondChunk.resolve(); await continueStream.promise }
      yield { kind: 'frames', frames: allFrames.slice(start, end) }
      end = start
    }
    allChunksRead.resolve()
    await completePage.promise
    yield { kind: 'complete', value: page }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  stream.push({ kind: 'replace', historyVersion: 1, frames: [bodyFrame('tail', 1_001)] })
  try {
    await reference.ready
    const binding = reference.binding, face = binding.session
    const projection = t.mock.method(runtime.SourceWindowStore.prototype, 'apply')
    unsubscribe = binding.eventSource.subscribe(() => changeKinds.push(binding.eventSource.getSnapshot().change.kind))
    const before = binding.eventSource.getSnapshot()
    const pending = face.loadOlder()
    await secondChunk.promise
    assert.equal(requests.length, 1, 'the complete page uses one remote stream open')
    assert.equal(requests[0]!.limit, 50, 'the source page matches HAPI regular paging')
    assert.equal(face.getSnapshot().loadingOlder, true, 'one paging gesture keeps one loading state across batches')
    const partial = binding.eventSource.getSnapshot()
    assert.equal(partial, before, 'transport chunks must not publish a partial page')
    assert.equal(projection.mock.callCount(), 0, 'transport chunks must not repeatedly project the resident window')
    assert.deepEqual(changeKinds, [])
    await face.loadOlder()
    assert.equal(requests.length, 1, 'another gesture cannot take ownership of the pending page')

    continueStream.resolve()
    await allChunksRead.promise
    assert.equal(chunks, Math.ceil(allFrames.length / SOURCE_HISTORY_FRAME_CHUNK_SIZE),
      'projected frames are delivered in bounded WebSocket messages')
    assert.equal(binding.eventSource.getSnapshot(), before, 'all frames still wait for the authoritative cursor record')
    assert.equal(projection.mock.callCount(), 0)
    assert.deepEqual(changeKinds, [])
    assert.equal(face.getSnapshot().loadingOlder, true, 'receiving the last frame does not finish page loading')
    completePage.resolve()
    await pending

    const after = binding.eventSource.getSnapshot()
    assert.equal(projection.mock.callCount(), 1, 'one complete source page projects the resident window once')
    assert.deepEqual(changeKinds, ['prepend'], 'one complete source page publishes one incremental prepend')
    assert.equal(after.revision, before.revision + 1)
    assert.deepEqual([requests[0]!.beforeSeq, requests[0]!.epoch, requests[0]!.cursorMessageId],
      [1_001, undefined, 'tail'], 'one HAPI page is anchored at the existing source cursor')
    assert.equal(after.change.kind, 'prepend', 'the existing viewport receives an incremental prepend')
    const sourceIds = [...new Set(after.entries.map(entry => (entry as unknown as { source?: { messageId: string } }).source?.messageId)
      .filter((id): id is string => !!id))]
    assert.equal(sourceIds.length, 51, 'all 50 older messages remain alongside the original tail')
    assert.deepEqual(sourceIds.slice(0, 3), ['message-801', 'message-802', 'message-803'])
    assert.equal(sourceIds.at(-1), 'tail')
    assert.equal(after.entries.at(-1), before.entries.at(-1), 'the original tail keeps its cached entry identity')
    assert.equal(face.getSnapshot().loadingOlder, false)
  } finally { continueStream.resolve(); completePage.resolve(); unsubscribe(); reference.release(); facade.dispose() }
})

test('an authoritative body rewrite deletes old rows and invalidates an outstanding source page', async () => {
  const h = harness({ id: sourceId(202), tail: [] }), stream = bodyStream()
  h.resolveReady()
  const entered = deferred<void>(), page = deferred<{ ok: true; value: SourceHistoryWindowValue }>()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceWindowFollow: () => stream,
    sourceHistoryWindowPage: async () => { entered.resolve(); return page.promise } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  stream.push({ kind: 'replace', historyVersion: 1, frames: [bodyFrame('deleted', 1), bodyFrame('retained', 2)] })
  try {
    await reference.ready
    const binding = reference.binding, face = binding.session as SessionFace & SourceViewportSession
    const pending = face.loadSourceMessage('older')
    await entered.promise
    stream.push({ kind: 'replace', reset: true, historyVersion: 2, frames: [bodyFrame('retained', 2)] })
    await bodyTick()
    page.resolve({ ok: true, value: windowValue([], { frames: [bodyFrame('obsolete-page', 0)] }) })
    assert.equal(await pending, undefined)
    assert.deepEqual(binding.eventSource.getSnapshot().entries.map(row => (row as unknown as { source: { messageId: string } }).source.messageId), ['retained'])
    assert.equal(reference.binding, binding)
    assert.equal(h.retainCalls.length, 1, 'rewriting source data must not replace its native operation owner')
  } finally { reference.release(); facade.dispose() }
})

for (const restarted of [false, true]) test(`a reconnect baseline observes a missed ${restarted ? 'Host restart' : 'history rewrite'} while an unchanged baseline retains history`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness({ id: sourceId(203), tail: [] }), first = bodyStream(), second = bodyStream()
  h.resolveReady()
  let calls = 0
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceWindowFollow: () => ++calls === 1 ? first : second }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  first.push({ kind: 'replace', historyId: 'first-owner', historyVersion: 1, frames: [bodyFrame('history', 1), bodyFrame('tail', 2)] })
  try {
    await reference.ready
    first.push({ kind: 'replace', historyId: 'first-owner', historyVersion: 1, frames: [bodyFrame('tail', 2)] })
    await bodyTick()
    assert.equal(reference.binding.eventSource.getSnapshot().entries.length, 2,
      'bounded reconnect data must not imply that older resident history was deleted')
    first.close()
    await bodyTick()
    second.push({ kind: 'replace', historyId: restarted ? 'restarted-owner' : 'first-owner', historyVersion: restarted ? 1 : 2, frames: [bodyFrame('tail', 2)] })
    t.mock.timers.tick(250)
    await bodyTick()
    assert.equal(calls, 2)
    assert.deepEqual(reference.binding.eventSource.getSnapshot().entries.map(row => (row as unknown as { source: { messageId: string } }).source.messageId), ['tail'],
      'a newer baseline version must remove rows deleted while the client was disconnected')
  } finally { reference.release(); facade.dispose(); t.mock.timers.reset() }
})

for (const turns of [8, 12]) for (const sourceHasOlder of [false, true]) {
  test(`opening ${turns}-turn source window recovers its complete prefix by source identity (archive ${sourceHasOlder})`, async () => {
    const id = sourceId(40 + turns + Number(sourceHasOlder)), threadId = `tail-gap-thread-${turns}`
    const { rows, bodyIds } = nativeMemoryWorkload(threadId, `tail-gap-${turns}`, turns, 1)
    const binding = { hubId: 'fixture', hapiSessionId: 'source', threadId, home: null, homeId: null, machineId: 'fixture' }
    const render = (values: typeof rows): SourceFrame[] => {
      const sink = new HistoryProjectionSink()
      const projector = new NativeProjector(sink, { model: () => 'fixture', provider: () => 'fixture',
        submittedMessage: () => undefined, stream: () => {} })
      projector.apply(values.flatMap(row => { const parsed = parseNativeRow(row, binding); return parsed ? [parsed] : [] }))
      return toSourceFrames({ events: sink.events, eventSources: sink.eventSources,
        turnAnchors: projector.turnAnchorEntries(), stepAnchors: projector.stepAnchorEntries() })
    }
    const cut = Math.floor(rows.length / 2), opening = render(rows.slice(cut))
    const h = harness({ id, tail: [frameTransport(opening)], tailHasMore: true })
    h.resolveReady()
    const requests: SourceHistoryWindowRequest[] = []
    const facade = new runtime.SourceSessions(h.original)
    facade.attach(apiWith({ sourceHistoryWindowPage: async request => {
      requests.push(request)
      return { ok: true, value: windowValue([], { frames: requests.length === 1 ? render(rows.slice(0, cut)) : [],
        before: { at: 1, seq: 1 }, beforeMessageId: rows[0]!.id,
        hasMoreBefore: requests.length === 1 && sourceHasOlder, hasMoreAfter: false }) }
    } }))
    const reference = facade.retain(id, { source: 'mainView' })
    try {
      await reference.ready
      await (reference.binding.session as SessionFace & SourceViewportSession).loadViewportPage()
      const recovered = reference.binding.eventSource.getSnapshot()
      assert.equal(h.loadOlderCalls, 0, 'source history has only one paging owner')
      assert.equal(requests.length, 1)
      assert.equal(requests[0]!.beforeSeq, opening[0]!.source!.seq)
      assert.equal(requests[0]!.startSeq, undefined)
      assert.equal(requests[0]!.endSeq, undefined)
      assert.equal(bodyIds.filter(body => JSON.stringify(recovered.entries).includes(body)).length, bodyIds.length,
        'the raw source prefix cannot disappear at the official event transport cut')
      const identities = recovered.entries.map(row => (row as unknown as { sourceFrameKey: string }).sourceFrameKey)
      assert.equal(new Set(identities).size, identities.length)
      assert.equal(reference.binding.session.getSnapshot().hasMore, sourceHasOlder)
      if (sourceHasOlder) {
        await reference.binding.session.loadOlder()
        assert.equal(requests.length, 2)
        assert.equal(h.loadOlderCalls, 0)
        assert.equal(reference.binding.session.getSnapshot().hasMore, false)
      }
    } finally { reference.release(); facade.dispose() }
  })
}

test('a committed page remains resident when the live source replaces its seed tail', async () => {
  const rows = Array.from({ length: 5020 }, (_, index) => {
    const row = locatedEvent(index)
    return { ...row, event: { ...row.event, seq: DISPLAY_SEQ_OFFSET + index } } as SessionEventLikeEntry
  })
  const h = harness({ id: sourceId(103), tail: rows.slice(5000), loadOlder: async events => {
    events.prepend(rows.slice(0, 5000), true)
  } })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryWindowPage: async () => ({ ok: true, value: windowValue(rows.slice(0, 5000)) }) }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  await reference.ready
  const session = reference.binding.session as SessionFace & SourceViewportSession
  const stop = session.registerWindowReader!({ available: () => true,
    read: () => ({ firstSeq: DISPLAY_SEQ_OFFSET + 5000, lastSeq: DISPLAY_SEQ_OFFSET + 5003, followingTail: false }) })
  try {
    const before = reference.binding.eventSource.getSnapshot()
    await session.loadOlder()
    const afterPage = reference.binding.eventSource.getSnapshot()
    assert.ok(afterPage.revision > before.revision, 'the oversized page commits into the resident history')
    assert.ok(sourceIdentities(reference.binding.eventSource).includes('visible-0'))
    assert.ok(sourceIdentities(reference.binding.eventSource).includes('visible-5003'))
    const repaired = rows.slice(5000).map(row => row.event.seq === DISPLAY_SEQ_OFFSET + 5003
      ? { ...row, event: { ...row.event, data: { ...row.event.data, content: [{ type: 'text', text: 'Recovered source body' }] } } } as SessionEventLikeEntry
      : row)
    h.eventSource.replace(repaired, true)
    await Promise.resolve(); await Promise.resolve()
    const after = reference.binding.eventSource.getSnapshot()
    assert.ok(after.revision > afterPage.revision, 'the new source tail updates after the older page')
    assert.ok(sourceIdentities(reference.binding.eventSource).includes('visible-0'), 'the older committed page stays resident')
    assert.ok(sourceIdentities(reference.binding.eventSource).includes('visible-5000'))
    assert.ok(sourceIdentities(reference.binding.eventSource).includes('visible-5003'))
    assert.ok(JSON.stringify(after.entries).includes('Recovered source body'), 'a real resident correction still commits after the unrelated page was refused')
    assert.ok(after.entries.length > repaired.length, 'the replacement tail is merged with its resident history')
  } finally { stop(); reference.release(); facade.dispose() }
})

for (const failure of ['no-progress', 'reject'] as const) {
  test(`a source prefix page ${failure} preserves its current reader and cursor`, async () => {
    const h = harness({ id: sourceId(failure === 'reject' ? 61 : 60), tail: [event(DISPLAY_SEQ_OFFSET + 19)],
      loadOlder: async () => { if (failure === 'reject') throw new Error('original page transport failed') } })
    h.resolveReady()
    const requests: SourceHistoryWindowRequest[] = []
    let mode: 'failed' | 'recover' = 'failed'
    const facade = new runtime.SourceSessions(h.original)
    facade.attach(apiWith({ sourceHistoryWindowPage: async request => {
      requests.push(request)
      if (mode === 'recover') return { ok: true, value: windowValue([], { hasMoreBefore: false, before: null }) }
      if (failure === 'reject') throw new Error('source page transport failed')
      return { ok: true, value: windowValue([], { hasMoreBefore: true }) }
    } }))
    const reference = facade.retain(h.id, { source: 'mainView' })
    try {
      await reference.ready
      if (failure === 'reject') await assert.rejects(() => reference.binding.session.loadOlder(), /source page transport failed/)
      else await assert.rejects(() => reference.binding.session.loadOlder(), /cursor did not advance/)
      assert.equal(h.loadOlderCalls, 0)
      assert.equal(requests.length, failure === 'reject' ? 1 : 2,
        'a non-advancing empty page is retried only to verify its cursor, then rejected')
      assert.deepEqual(seqs(reference.binding.eventSource.getSnapshot()), [DISPLAY_SEQ_OFFSET + 19])
      assert.equal(reference.binding.session.getSnapshot().hasMore, true)
      assert.equal(reference.binding.session.getSnapshot().loadingOlder, false)
      const source = reference.binding.session as SessionFace & Partial<SourceViewportSession>
      assert.equal(source.sourceWindow?.getSnapshot().pagingError, true,
        'the failed request remains distinguishable from an idle Load earlier button')

      mode = 'recover'
      await reference.binding.session.loadOlder()
      assert.equal(source.sourceWindow?.getSnapshot().pagingError, undefined,
        'a successful retry clears the visible failure state')
      assert.equal(reference.binding.session.getSnapshot().hasMore, false)
      assert.deepEqual(seqs(reference.binding.eventSource.getSnapshot()), [DISPLAY_SEQ_OFFSET + 19],
        'the successful empty terminal page preserves the already visible transcript')
    } finally { reference.release(); facade.dispose() }
  })
}


interface LatestSession extends SessionFace, SourceViewportSession { returnToLive(signal?: AbortSignal): boolean | Promise<boolean> }
function finishNavigation(session: SessionFace): Promise<void> {
  if (!session.getSnapshot().loadingOlder) return Promise.resolve()
  return within(new Promise<void>(resolve => {
    const stop = session.subscribe(() => { if (!session.getSnapshot().loadingOlder) { stop(); resolve() } })
  }), 'latest navigation did not settle')
}

async function candidateHarness(index: number, page?: NonNullable<Parameters<typeof apiWith>[0]>['sourceHistoryWindowPage']) {
  const id = sourceId(index), ctx = new Context(), scope = runtime.createScope(ctx, id)
  const h = harness({ id, ctx: scope.ctx, tail: [event(10)], tailOutline: [{ turn: 0, seq: 11, prompt: '', response: '' }] })
  h.resolveReady()
  const requests: SourceHistoryWindowRequest[] = []
  const facade = new runtime.SourceSessions(h.original)
  const sourceOutline = { ...outlineValue([]), head: { messageId: 'new-head', at: 100, seq: 100 } }
  facade.attach(apiWith({
    sourceHistoryOutline: async () => ({ ok: true, value: sourceOutline }),
    sourceHistoryWindowPage: async request => {
      requests.push(request)
      if (page) return page(request)
      const first = request.beforeSeq === undefined ? 3_001_000_000 : 3_000_999_999
      return { ok: true, value: windowValue([event(first)], {
        hasMoreBefore: request.beforeSeq === undefined, hasMoreAfter: false,
        before: { at: first, seq: first }, after: { at: 100, seq: 100 },
      }) }
    },
  }))
  const reference = facade.retain(id, { source: 'mainView' })
  await reference.ready
  return { h, facade, reference, requests, session: reference.binding.session as LatestSession,
    async dispose() { reference.release(); facade.dispose(); await scope.fiber.dispose() } }
}

test('latest prepares a local official binding while the existing reader and native lease remain unchanged', { timeout: 5_000 }, async () => {
  const fixture = await candidateHarness(81)
  const { facade, reference, requests, session, h } = fixture
  const mounted = deferred<SessionReference>(), unmount = deferred<boolean>()
  let contextDisposed = false
  const stop = session.registerWindowPreparer!({ available: () => true, prepare: async candidate => {
    candidate.binding.ctx.effect(() => () => { contextDisposed = true })
    mounted.resolve(candidate)
    return unmount.promise
  } })
  try {
    const visible = reference.binding, prior = visible.eventSource.getSnapshot()
    const opening = session.returnToLive()
    const done = finishNavigation(session), candidate = await within(mounted.promise, 'candidate was not prepared')
    assert.notEqual(candidate.sessionId, h.id)
    assert.equal(facade.binding(candidate.sessionId), candidate.binding)
    assert.equal(facade.scope(candidate.sessionId), candidate.binding.ctx)
    assert.equal(facade.scopeOf(candidate.binding.ctx as Context), undefined, 'presentation context must not inherit the original native identity')
    assert.equal(facade.sessionOf(candidate.binding.ctx as Context), undefined, 'input shell must have no native controller/trigger route')
    assert.equal((candidate.binding.ctx as Context).sessions, facade)
    assert.equal(facade.scopeOf(visible.ctx as Context), h.id, 'the original owner remains tagged')
    assert.equal(facade.binding(h.id), visible)
    assert.equal(visible.eventSource.getSnapshot(), prior, 'preparation must not publish into the visible reader')
    assert.equal(h.retainCalls.length, 1, 'the temporary official renderer must not acquire another native lease')
    assert.throws(() => candidate.binding.session.cancel(), /read-only/)
    const candidateSession = candidate.binding.session as SessionFace & SourceViewportSession
    await candidateSession.loadViewportPage()
    assert.equal(requests[1]?.limit, 20)
    assert.equal(requests[1]?.sessionId, h.id, 'paging routes to the original source identity')
    assert.equal(candidate.binding.eventSource.getSnapshot().entries.length, 2)
    assert.equal(visible.eventSource.getSnapshot(), prior, 'candidate paging is detached from the visible reader')
    unmount.resolve(true)
    await done
    assert.equal(await opening, true, 'completion requires both preparation cleanup and visible source publication')
    assert.equal(contextDisposed, true)
    assert.equal(facade.binding(candidate.sessionId), undefined)
    assert.equal(facade.binding(h.id), visible, 'commit retains the original binding and editor owner')
    assert.equal(visible.eventSource.getSnapshot().entries.length, 2)
    assert.equal(visible.eventSource.getSnapshot().revision, prior.revision + 1, 'admit the complete prepared window in one publication')
  } finally { unmount.resolve(false); stop(); await fixture.dispose() }
})

test('prepared latest pages preserve separate before and after epochs at publication', { timeout: 5_000 }, async () => {
  let beforePages = 0
  const fixture = await candidateHarness(87, async request => {
    const backward = request.beforeSeq !== undefined
    const ordinal = backward ? 100 - (++beforePages * 10) : request.afterSeq !== undefined ? 110 : 100
    const epoch = backward ? 7 + beforePages : request.afterSeq !== undefined ? 20 : 7
    const seq = 3_000_000_000 + ordinal
    return { ok: true, value: windowValue([event(seq)], {
      epoch, before: { at: ordinal, seq: ordinal }, after: { at: ordinal, seq: ordinal },
      beforeMessageId: `edge-${ordinal}`, afterMessageId: `edge-${ordinal}`,
    }) }
  })
  const { session, reference, requests } = fixture
  const stop = session.registerWindowPreparer!({ available: () => true, prepare: async candidate => {
    const face = candidate.binding.session as SessionFace & SourceViewportSession
    await face.loadViewportPage()
    await face.loadViewportPage()
    return true
  } })
  try {
    const binding = reference.binding
    assert.equal(await session.returnToLive(), true)
    assert.equal(reference.binding, binding)
    assert.equal(requests[0]!.epoch, undefined)
    assert.deepEqual([requests[1]!.epoch, requests[1]!.cursorMessageId], [7, 'edge-100'])
    assert.deepEqual([requests[2]!.epoch, requests[2]!.cursorMessageId], [8, 'edge-90'])
    assert.equal(await (session as LatestSession & { loadAfter(): Promise<boolean> }).loadAfter(), true)
    assert.deepEqual([requests[3]!.epoch, requests[3]!.cursorMessageId], [7, 'edge-100'],
      'publishing a candidate with epoch 9 prepended must preserve its original epoch 7 forward edge')
    await session.loadOlder()
    assert.deepEqual([requests[4]!.epoch, requests[4]!.cursorMessageId], [9, 'edge-80'])
  } finally { stop(); await fixture.dispose() }
})

for (const failure of ['declined', 'unregistered', 'superseded'] as const) {
  test(`latest candidate ${failure} keeps the previous reader and disposes its presentation context`, { timeout: 5_000 }, async () => {
    const fixture = await candidateHarness(failure === 'declined' ? 82 : failure === 'unregistered' ? 83 : 84)
    const { facade, reference, session } = fixture
    const mounted = deferred<{ reference: SessionReference; signal: AbortSignal }>(), gate = deferred<boolean>()
    let disposed = false
    const cleanup = deferred<void>()
    const stop = session.registerWindowPreparer!({ available: () => true, prepare: async (candidate, signal) => {
      candidate.binding.ctx.effect(() => () => { disposed = true; cleanup.resolve() })
      mounted.resolve({ reference: candidate, signal })
      return gate.promise
    } })
    try {
      const prior = reference.binding.eventSource.getSnapshot()
      session.returnToLive()
      const done = finishNavigation(session), candidate = await mounted.promise
      if (failure === 'unregistered') stop()
      if (failure === 'superseded') await session.loadThrough(11 as SessionSeq)
      if (failure !== 'declined') assert.equal(candidate.signal.aborted, true)
      gate.resolve(failure !== 'declined')
      await done
      await within(cleanup.promise, 'candidate context was not disposed')
      // The superseding tail navigation restores this fixture's original reader.
      assert.deepEqual(seqs(reference.binding.eventSource.getSnapshot()), seqs(prior))
      assert.equal(disposed, true)
      assert.equal(facade.binding(candidate.reference.sessionId), undefined)
    } finally { gate.resolve(false); stop(); await fixture.dispose() }
  })
}

test('a parked reader cannot bypass previously registered viewport admission', { timeout: 5_000 }, async () => {
  const fixture = await candidateHarness(85)
  const { reference, session, h } = fixture
  let prepared = 0
  const stop = session.registerWindowPreparer!({ available: () => false, prepare: async () => { prepared++; return true } })
  try {
    const prior = reference.binding.eventSource.getSnapshot()
    session.returnToLive(); await finishNavigation(session)
    assert.equal(prepared, 0)
    assert.equal(reference.binding.eventSource.getSnapshot(), prior)
    stop()
    session.returnToLive(); await finishNavigation(session)
    assert.equal(reference.binding.eventSource.getSnapshot(), prior, 'unregistering a mounted view is not initial admission')
    assert.equal(h.retainCalls.length, 1)
  } finally { stop(); await fixture.dispose() }
})

for (const accepted of [true, false]) {
  test(`natural updates during candidate preparation survive ${accepted ? 'admission' : 'rejection'} exactly once`, { timeout: 5_000 }, async () => {
    const fixture = await candidateHarness(accepted ? 86 : 87)
    const { session, reference, h } = fixture
    const mounted = deferred<void>(), gate = deferred<boolean>()
    const stop = session.registerWindowPreparer!({ available: () => true, prepare: async () => { mounted.resolve(); return gate.promise } })
    try {
      session.returnToLive()
      const done = finishNavigation(session)
      await mounted.promise
      const incoming = { type: 'event', event: { seq: 11, time: 11, type: 'user/message', data: { id: 'during-preview', message: { content: [] } } } } as unknown as SessionEventLikeEntry
      h.eventSource.append(incoming)
      gate.resolve(accepted)
      await done
      const records = reference.binding.eventSource.getSnapshot().entries
      assert.equal(records.filter(row => (row.event.data as { id?: string }).id === 'during-preview').length, 1)
      assert.equal(records.length, 2)
      assert.equal(records.some(row => Number(row.event.seq) > 3_000_000_000), accepted, 'only admitted candidate content replaces the old reader')
    } finally { gate.resolve(false); stop(); await fixture.dispose() }
  })
}

test('superseding latest waits for the previous candidate to unmount before creating its successor', { timeout: 5_000 }, async () => {
  const fixture = await candidateHarness(88)
  const { session, facade } = fixture
  const first = deferred<{ reference: SessionReference; signal: AbortSignal }>(), second = deferred<SessionReference>()
  const unmount = deferred<boolean>()
  let calls = 0
  const stop = session.registerWindowPreparer!({ available: () => true, prepare: async (reference, signal) => {
    calls++
    if (calls === 1) { first.resolve({ reference, signal }); return unmount.promise }
    second.resolve(reference)
    return true
  } })
  try {
    session.returnToLive()
    const candidate = await first.promise
    session.returnToLive()
    const done = finishNavigation(session)
    await Promise.resolve(); await Promise.resolve()
    assert.equal(candidate.signal.aborted, true)
    assert.equal(calls, 1, 'a successor cannot mount before the old preview has unmounted')
    assert.equal(facade.binding(candidate.reference.sessionId), candidate.reference.binding)
    unmount.resolve(true)
    const replacement = await within(second.promise, 'the replacement candidate did not mount')
    assert.equal(facade.binding(candidate.reference.sessionId), undefined)
    assert.notEqual(replacement.sessionId, candidate.reference.sessionId)
    await done
    assert.equal(facade.binding(replacement.sessionId), undefined)
  } finally { unmount.resolve(false); stop(); await fixture.dispose() }
})

function locatedEvent(seq: number, epoch?: number): SessionEventLikeEntry {
  return { type: 'event', source: { messageId: `visible-${seq}`, at: seq, seq, ...(epoch === undefined ? {} : { epoch }) }, event: {
    type: 'user/message', seq, time: seq, data: { id: `visible-${seq}`, message: { content: [] } },
  } } as unknown as SessionEventLikeEntry
}
const sourceIdentities = (source: SessionEventSource): string[] => source.getSnapshot().entries.map(row => (row as unknown as { source: { messageId: string } }).source.messageId)

test('live commits do not wait for reader quiet or lose the final event while another source is moving', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const moving = harness({ id: sourceId(105), tail: Array.from({ length: 10 }, (_, index) => locatedEvent(index)) })
  const sibling = harness({ id: sourceId(106), tail: Array.from({ length: 10 }, (_, index) => locatedEvent(index)) })
  moving.resolveReady(); sibling.resolveReady()
  const movingFacade = new runtime.SourceSessions(moving.original), siblingFacade = new runtime.SourceSessions(sibling.original)
  movingFacade.attach(apiWith()); siblingFacade.attach(apiWith())
  const reading = movingFacade.retain(moving.id, { source: 'mainView' })
  const background = siblingFacade.retain(sibling.id, { source: 'mainView' })
  await Promise.all([reading.ready, background.ready])
  let firstVisible = 6
  const session = reading.binding.session as SessionFace & SourceViewportSession
  const stop = session.registerWindowReader!({ available: () => true,
    read: () => ({ firstSeq: firstVisible, lastSeq: 9, followingTail: true }) })
  try {
    const binding = reading.binding
    for (let seq = 10; seq < 13; seq++) {
      firstVisible-- // Reader geometry changes while new messages arrive.
      moving.eventSource.append(locatedEvent(seq))
      sibling.eventSource.append(locatedEvent(seq))
      await Promise.resolve(); await Promise.resolve()
      assert.equal(sourceIdentities(reading.binding.eventSource).at(-1), `visible-${seq}`,
        'each update, including the final isolated event, must reach the visible tail without advancing a timer')
      assert.equal(sourceIdentities(background.binding.eventSource).at(-1), `visible-${seq}`,
        'another source must not inherit this reader activity')
      assert.ok(sourceIdentities(reading.binding.eventSource).includes(`visible-${firstVisible}`),
        'publishing live data must preserve the measured reading range')
      assert.equal(reading.binding, binding)
    }
  } finally {
    stop(); reading.release(); background.release(); movingFacade.dispose(); siblingFacade.dispose(); t.mock.timers.reset()
  }
})

test('a source binding keeps the contiguous window bounded and exposes the forward cursor', { timeout: 5_000 }, async () => {
  const tail = Array.from({ length: 1_200 }, (_, index) => locatedEvent(10_000 + index))
  const older = Array.from({ length: 80 }, (_, index) => locatedEvent(9_920 + index))
  const h = harness({ id: sourceId(91), tail })
  h.resolveReady()
  const requests: SourceHistoryWindowRequest[] = []
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryWindowPage: async request => {
    requests.push(request)
    return { ok: true, value: windowValue(older, { before: { at: 9_920, seq: 9_920 }, hasMoreBefore: true }) }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    await reference.ready
    await reference.binding.session.loadOlder()
    const afterPage = sourceIdentities(reference.binding.eventSource)
    assert.equal(requests.length, 1, 'one gesture commits one contiguous page')
    assert.equal(afterPage.length, 800, 'the resident projection follows the HAPI history window')
    assert.equal(afterPage[0], 'visible-9920')
    assert.equal(afterPage.at(-1), 'visible-10719')
    assert.equal((reference.binding.session as SessionFace & SourceViewportSession).sourceWindow.getSnapshot().hasMoreAfter, true,
      'the evicted newer interval remains reachable through its source cursor')

    h.eventSource.append(locatedEvent(11_200))
    await Promise.resolve(); await Promise.resolve()
    const afterLive = sourceIdentities(reference.binding.eventSource)
    assert.equal(afterLive.length, 800, 'live tail rows do not create a gap inside the resident transcript')
    assert.equal(afterLive[0], 'visible-9920')
    assert.equal(afterLive.at(-1), 'visible-10719')
    assert.deepEqual(afterPage, afterLive, 'the detached reader keeps its contiguous loaded interval')
  } finally { reference.release(); facade.dispose() }
})
