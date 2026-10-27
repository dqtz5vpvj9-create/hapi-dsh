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
import { nativeMemoryWorkload } from '../e2e/source-window-memory-helpers.ts'
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
  MutableSessionEventSource: new () => MutableEventSource
  createScope(ctx: Context, id: SessionId): { ctx: SessionBinding['ctx']; fiber: { dispose(): Promise<void> } }
  scopeOf(ctx: Context): SessionId | undefined
}

let runtime: Runtime

before(async () => {
  const contents = [
    `export { SourceSessions } from ${JSON.stringify(join(root, 'src/client/source-sessions.ts'))}`,
    `export { createScope, scopeOf } from ${JSON.stringify(join(controllerRoot, 'lib/types/client/scope.js'))}`,
    "export { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'",
  ].join('\n')
  const built = await build({
    stdin: { contents, resolveDir: root, sourcefile: 'source-sessions-contract-entry.ts', loader: 'ts' },
    alias: { '@deepseek-ai/dsh-api-session-controller/client': contractEvents },
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

test('actual viewport admission passes measured page sizes while ordinary paging retains its default', async () => {
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
    assert.deepEqual(requests.map(request => request.limit), [20, 80, 200])
    assert.equal(requests[0]!.fromOldest, true)
    assert.deepEqual(requests.slice(1).map(request => request.beforeSeq), [980, 960])
    assert.equal(reference.binding.eventSource.getSnapshot().entries.length, 61)
    await reference.binding.session.loadOlder()
    assert.equal(requests[3]!.limit, undefined, 'interactive history keeps its normal backend batching')
    assert.equal(requests[3]!.beforeSeq, 940, 'the first interactive page continues the admitted window')
    assert.equal(h.loadOlderCalls, 0, 'the source facade remains the only source paging owner')
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

test('preparation opens the same binding before a slow outline while public ready waits for both', { timeout: 5_000 }, async () => {
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
    assert.deepEqual(readyOutcomes, [], 'preparation must not admit a source whose full outline is pending')
    assert.deepEqual(h.retainCalls, [{ target: h.id, source: 'mainView' }])
    assert.equal(h.liveReferences, 1, 'preparation must use the caller existing original lease')
    outlineGate.resolve(undefined)
    assert.equal(await within(reference.ready, 'complete source readiness never settled'), prepared)
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

test('ready waits for the source-wide outline and exposes merged host/tail turns before use', { timeout: 5_000 }, async () => {
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
    const settled: string[] = []
    void reference.ready.then(() => { settled.push('resolved') }, () => { settled.push('rejected') })
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.deepEqual(settled, [], 'ready must not resolve before the source-wide outline is available')
    outlineGate.resolve(undefined)
    const binding = await within(reference.ready, 'source reference did not become ready')
    assert.deepEqual(calls, [h.id], 'the facade must prefetch the outline once for this source')
    assert.deepEqual(outlineRowsOf(binding).map(entry => entry.turn), [0, 1, 2],
      'the projection must expose the source-wide turn ladder in order')
    assert.equal(outlineRowsOf(binding)[1]?.prompt, 'host-one',
      'the host outline must win over a duplicate loaded-tail turn')
    assert.equal(binding, reference.binding, 'ready must resolve the same stable binding')
  } finally {
    reference.release()
  }
})

test('a late source API attach cannot leave ready resolved with only the loaded tail', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(5), tailOutline: [{ turn: 1, seq: 10, prompt: 'tail-only', response: 'tail' }] })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  const reference = facade.retain(h.id, { source: 'mainView' })
  try {
    const outcomes: string[] = []
    void reference.ready.then(() => { outcomes.push('resolved') }, error => { outcomes.push(`rejected:${String(error)}`) })
    await new Promise(resolve => setTimeout(resolve, 30))
    const resolvedBeforeAttach = outcomes.length > 0

    facade.attach(apiWith({
      sourceHistoryOutline: async () => ({ ok: true, value: outlineValue([
        { turn: 0, seq: 5, prompt: 'host-zero', response: 'zero' },
        { turn: 1, seq: 10, prompt: 'host-one', response: 'one' },
      ]) }),
    }))
    const binding = await within(reference.ready, 'source reference did not become ready after late attach')

    assert.equal(resolvedBeforeAttach, false,
      'ready must not silently resolve as complete while the source outline API is only attached later')
    assert.deepEqual(outlineRowsOf(binding).map(entry => entry.turn), [0, 1],
      'a late attach must backfill the source-wide outline instead of painting the loaded tail as full')
  } finally {
    reference.release()
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
    complete.resolve(undefined)
    for (let index = 0; index < 80; index++) {
      if (outlineRowsOf(binding).map(row => row.prompt).join(',') === 'host-zero,host-one') break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
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
      assert.deepEqual(seqs(reference.binding.eventSource.getSnapshot()), [10],
        'the body window stays exactly as loaded')
      assert.ok(calls >= 1)
    } finally { reference.release(); facade.dispose() }
  })
}

for (const stage of ['attach', 'rpc', 'indexing'] as const) {
  test(`releasing the last cold occurrence cancels its ${stage} wait and ignores late completion`, async () => {
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
      reference.release()
      await assert.rejects(within(reference.ready, 'released readiness did not settle', 100), /released/)
      assert.equal(h.liveReferences, 0)
      reply.resolve(undefined)
      if (stage === 'attach') { facade.attach(api); h.resolveReady() }
      await new Promise(resolve => setTimeout(resolve, 450))
      assert.equal(calls, stage === 'attach' ? 0 : 1, 'release must stop scheduled reads')
      assert.equal(changes, 0, 'late metadata cannot publish into the released occurrence')
      assert.equal(facade.binding(h.id), undefined)
    } finally { reply.resolve(undefined); stop(); reference.release(); facade.dispose() }
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
    t.mock.timers.tick(5_000)
    assert.equal(await reference.ready, reference.binding, 'a stalled page degrades navigation instead of blocking the open')
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
    const binding = await reference.ready, before = outlineRowsOf(binding)
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
    assert.equal(calls, 3, 'concurrent references must share one bounded failed attempt')
    first.release()
    assert.equal(h.liveReferences, 1, 'another reference must keep the degraded source record alive')
    assert.equal(facade.binding(h.id), binding)

    available = true
    retry = facade.retain(h.id, { source: 'mainView' })
    assert.equal(await within(retry.ready, 'a new retain did not recover the directory'), binding)
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
    assert.equal(typeof requests[0]?.startSeq, 'number', 'the target window must carry a display seq base')
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

for (const turns of [8, 12]) for (const sourceHasOlder of [false, true]) {
  test(`opening ${turns}-turn seed recovers its omitted prefix before source paging (archive ${sourceHasOlder})`, async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(TypertRegistry)
    class FixtureQuery extends SessionQueryEngine {
      override searchSessions(): Promise<never> { throw new Error('unused search') }
      override searchEvents(): Promise<never> { throw new Error('unused search') }
    }
    new FixtureQuery(ctx)
    new SessionTitleService(ctx, { fallbackMaxWords: 20, fallbackMaxBytes: 256, maxTitleBytes: 256 })
    ctx.provide('fileUploads', { registerAgentResolver: () => () => {} } as unknown as Context['fileUploads'])
    const id = sourceId(40 + turns + Number(sourceHasOlder))
    const threadId = `tail-gap-thread-${turns}`
    const { rows, bodyIds } = nativeMemoryWorkload(threadId, `tail-gap-${turns}`, turns, 1)
    const projector = new NativeProjector(Session.create(id), { model: () => 'fixture', provider: () => 'fixture',
      submittedMessage: () => undefined, stream: () => {} })
    projector.beginHistorySeed()
    const nativeBinding = { hubId: 'fixture', hapiSessionId: 'source', threadId, home: null, homeId: null, machineId: 'fixture' }
    projector.apply(rows.flatMap(row => { const parsed = parseNativeRow(row, nativeBinding); return parsed ? [parsed] : [] }))
    const session = ctx.sessions.create(id, { seed: projector.historySeed(), meta: { cwd: '/workspace/fixture' } })
    const ordinary = new SessionController(ctx, { nativeOpen: false, listWorkSliceMs: 16 })
    const window = new SourceHistoryWindow({ id, binding: { hapiSessionId: 'source' },
      historyWindowAnchor: () => ({ epoch: 1, before: { at: 1, seq: 1 }, firstTurn: 1, hasOlder: sourceHasOlder }),
      renderHistoryPage: () => { throw new Error('the retained seed uses the original official page') },
    }, {} as HapiTransport)
    const throughSeq = (DISPLAY_SEQ_OFFSET + session.seq - 1) as SessionSeq
    const address = { kind: 'session' as const, sessionId: id }
    const page = (request: Parameters<SourceHistoryWindow['page']>[0]) => window.page(request, undefined,
      next => ordinary.page(next, new AbortController().signal))
    const opening = await page({ ...openingWindow({ address, maxMessages: 500,
      turnWindow: { minMessages: 50, minTurns: 2 } }), throughSeq })
    assert.equal(opening.records[0]!.event.seq, DISPLAY_SEQ_OFFSET + (turns === 8 ? 19 : 79),
      'the real official 20-message cut starts inside the retained native seed')
    assert.equal(bodyIds.filter(id => JSON.stringify(opening.records).includes(id)).length, 13)
    const h = harness({ id, tail: opening.records, tailHasMore: opening.hasMore, loadOlder: async events => {
      const older = await page({ address, throughSeq, beforeSeq: events.getSnapshot().entries[0]!.event.seq,
        maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })
      events.prepend(older.records, older.hasMore)
    } })
    h.resolveReady()
    const requests: SourceHistoryWindowRequest[] = []
    const facade = new runtime.SourceSessions(h.original)
    facade.attach(apiWith({ sourceHistoryWindowPage: async request => {
      requests.push(request)
      return { ok: true, value: windowValue([event(DISPLAY_SEQ_OFFSET - 1)], { hasMoreBefore: false }) }
    } }))
    const reference = facade.retain(id, { source: 'mainView' })
    try {
      await reference.ready
      await (reference.binding.session as SessionFace & SourceViewportSession).loadViewportPage()
      const recovered = reference.binding.eventSource.getSnapshot()
      assert.equal(h.loadOlderCalls, 1, 'one bounded original page recovers the seed prefix')
      assert.equal(requests.length, 0, 'source cursor must not skip the unreceived original prefix')
      assert.deepEqual(seqs(recovered), Array.from({ length: session.seq }, (_, index) => DISPLAY_SEQ_OFFSET + index),
        'all lifecycle, body and annotation events survive the opening cut exactly once')
      assert.equal(bodyIds.filter(id => JSON.stringify(recovered.entries).includes(id)).length, bodyIds.length)
      assert.equal(recovered.hasMore, sourceHasOlder)
      assert.equal(reference.binding.session.getSnapshot().hasMore, sourceHasOlder)
      if (sourceHasOlder) {
        await reference.binding.session.loadOlder()
        assert.equal(h.loadOlderCalls, 1, 'source archive paging must not accumulate in the original ClientSession')
        assert.equal(requests.length, 1)
        assert.equal(requests[0]!.fromOldest, true)
        assert.equal(requests[0]!.endSeq, DISPLAY_SEQ_OFFSET)
        assert.equal(reference.binding.session.getSnapshot().hasMore, false)
      }
    } finally { reference.release(); facade.dispose(); window.dispose(); await ctx.fiber.dispose() }
  })
}

for (const batch of ['single', 'multiple', 'replaced'] as const) {
test(`the official seed prefix stays readable until the page reader moves (${batch})`, async () => {
  const rows = Array.from({ length: 120 }, (_, index) => {
    const row = locatedEvent(index)
    return { ...row, event: { ...row.event, seq: DISPLAY_SEQ_OFFSET + index } } as SessionEventLikeEntry
  })
  const h = harness({ id: sourceId(102), tail: rows.slice(100), loadOlder: async events => {
    if (batch === 'single') events.prepend(rows.slice(0, 100), false)
    else if (batch === 'multiple') {
      events.prepend(rows.slice(50, 100), true)
      events.prepend(rows.slice(0, 50), false)
    } else {
      events.prepend(rows.slice(0, 50), true)
      events.replace(rows.slice(80), true)
      events.prepend(rows.slice(50, 80), false)
    }
  } })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryWindowPage: async () => { throw new Error('seed prefix is already on the original pager') } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  await reference.ready
  const session = reference.binding.session as SessionFace & SourceViewportSession
  let visible = 100
  const stop = session.registerWindowReader!({ available: () => true,
    read: () => ({ firstSeq: DISPLAY_SEQ_OFFSET + visible, lastSeq: DISPLAY_SEQ_OFFSET + visible + 3, followingTail: false }) })
  try {
    await session.loadOlder()
    assert.equal(h.loadOlderCalls, 1)
    const first = batch === 'replaced' ? 'visible-50' : 'visible-0'
    assert.ok(sourceIdentities(reference.binding.eventSource).includes(first),
      'the original prepend must not be evicted before its first DOM commit')
    if (batch === 'replaced') assert.equal(sourceIdentities(reference.binding.eventSource).includes('visible-0'), false,
      'a superseded prefix must not hold a replacement snapshot hostage')
    const append = async (index: number): Promise<void> => {
      const row = locatedEvent(103)
      h.eventSource.append({ ...row, event: { ...row.event, seq: DISPLAY_SEQ_OFFSET + index } } as SessionEventLikeEntry)
      await Promise.resolve(); await Promise.resolve()
    }
    await append(120)
    assert.ok(sourceIdentities(reference.binding.eventSource).includes(first),
      'unchanged pre-page geometry cannot release the fetched prefix')
    visible = 101
    await append(121)
    assert.equal(sourceIdentities(reference.binding.eventSource).includes(first), false,
      'reader movement releases page protection and restores bounded locality')
  } finally { stop(); reference.release(); facade.dispose() }
})
}

test('a replacement can retire an uncommitted seed page after its budget was refused', async () => {
  const rows = Array.from({ length: 5020 }, (_, index) => {
    const row = locatedEvent(index)
    return { ...row, event: { ...row.event, seq: DISPLAY_SEQ_OFFSET + index } } as SessionEventLikeEntry
  })
  const h = harness({ id: sourceId(103), tail: rows.slice(5000), loadOlder: async events => {
    events.prepend(rows.slice(0, 5000), true)
  } })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith())
  const reference = facade.retain(h.id, { source: 'mainView' })
  await reference.ready
  const session = reference.binding.session as SessionFace & SourceViewportSession
  const stop = session.registerWindowReader!({ available: () => true,
    read: () => ({ firstSeq: DISPLAY_SEQ_OFFSET + 5000, lastSeq: DISPLAY_SEQ_OFFSET + 5003, followingTail: false }) })
  try {
    const before = reference.binding.eventSource.getSnapshot()
    await session.loadOlder()
    assert.equal(reference.binding.eventSource.getSnapshot().revision, before.revision,
      'an oversized protected page must leave the visible window unchanged')
    h.eventSource.replace(rows.slice(5000), true)
    await Promise.resolve(); await Promise.resolve()
    const after = reference.binding.eventSource.getSnapshot()
    assert.ok(after.revision > before.revision, 'a discarded pending prefix must not block the replacement snapshot')
    assert.ok(sourceIdentities(reference.binding.eventSource).includes('visible-5000'))
    assert.ok(sourceIdentities(reference.binding.eventSource).includes('visible-5003'))
    assert.ok(after.entries.length < 100, 'the replacement still obeys viewport locality')
  } finally { stop(); reference.release(); facade.dispose() }
})

for (const failure of ['no-progress', 'reject'] as const) {
  test(`an original prefix page ${failure} never skips to the source archive`, async () => {
    const h = harness({ id: sourceId(failure === 'reject' ? 61 : 60), tail: [event(DISPLAY_SEQ_OFFSET + 19)],
      loadOlder: async () => { if (failure === 'reject') throw new Error('original page transport failed') } })
    h.resolveReady()
    const requests: SourceHistoryWindowRequest[] = []
    const facade = new runtime.SourceSessions(h.original)
    facade.attach(apiWith({ sourceHistoryWindowPage: async request => {
      requests.push(request); return { ok: true, value: windowValue([], { hasMoreBefore: false }) }
    } }))
    const reference = facade.retain(h.id, { source: 'mainView' })
    try {
      await reference.ready
      if (failure === 'reject') await assert.rejects(() => reference.binding.session.loadOlder(), /original page transport failed/)
      else await reference.binding.session.loadOlder()
      assert.equal(h.loadOlderCalls, 1)
      assert.equal(requests.length, 0)
      assert.deepEqual(seqs(reference.binding.eventSource.getSnapshot()), [DISPLAY_SEQ_OFFSET + 19])
      assert.equal(reference.binding.session.getSnapshot().hasMore, true)
      assert.equal(reference.binding.session.getSnapshot().loadingOlder, false)
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
      const first = request.endSeq === undefined ? Number(request.startSeq) : request.endSeq - 1
      return { ok: true, value: windowValue([event(first)], {
        hasMoreBefore: request.endSeq === undefined, hasMoreAfter: false,
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
    const seq = backward ? request.endSeq! - 1 : request.startSeq!
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
      assert.equal(Number(records[0]?.event.seq) > 3_000_000_000, accepted)
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

for (const secondPane of ['none', 'tail', 'unknown'] as const) {
  test(`visible history pins survive live updates with ${secondPane} second pane`, { timeout: 5_000 }, async () => {
    const h = harness({ id: sourceId(secondPane === 'none' ? 91 : secondPane === 'tail' ? 92 : 93),
      tail: Array.from({ length: 100 }, (_, index) => locatedEvent(index)) })
    h.resolveReady()
    const facade = new runtime.SourceSessions(h.original)
    facade.attach(apiWith())
    const reference = facade.retain(h.id, { source: 'mainView' })
    await reference.ready
    const session = reference.binding.session as SessionFace & SourceViewportSession
    const stops = [session.registerWindowReader!({ available: () => true,
      read: () => ({ firstSeq: 40, lastSeq: 43, followingTail: false }) })]
    if (secondPane !== 'none') stops.push(session.registerWindowReader!({ available: () => true,
      read: () => secondPane === 'unknown' ? undefined : { firstSeq: 96, lastSeq: 99, followingTail: true } }))
    try {
      h.eventSource.append(locatedEvent(100))
      await Promise.resolve(); await Promise.resolve()
      const first = sourceIdentities(reference.binding.eventSource)
      assert.ok(first.includes('visible-40') && first.includes('visible-43'))
      if (secondPane === 'none') assert.deepEqual(first, Array.from({ length: 16 }, (_, index) => `visible-${34 + index}`))
      if (secondPane === 'tail') assert.ok(first.includes('visible-100'), 'a second tail reader must receive the live head')
      if (secondPane === 'unknown') assert.equal(first.length, 101, 'one unknown visible pane prevents locality eviction for its sibling')
      h.eventSource.append(locatedEvent(101))
      await Promise.resolve(); await Promise.resolve()
      const next = sourceIdentities(reference.binding.eventSource)
      assert.ok(next.includes('visible-40') && next.includes('visible-43'))
      if (secondPane === 'none') assert.deepEqual(next, first, 'distant new rows stay outside the historical reading interval')
      else assert.ok(next.includes('visible-101'), 'live data is not silently parked when another pane may follow it')
    } finally { stops.forEach(stop => stop()); reference.release(); facade.dispose() }
  })
}

for (const mode of ['tail', 'window'] as const) {
  test(`a following ${mode} preserves measured readable rows until layout confirms the new tail`, { timeout: 5_000 }, async () => {
    const h = harness({ id: sourceId(mode === 'tail' ? 96 : 97),
      tail: Array.from({ length: 80 }, (_, index) => locatedEvent(index)) })
    h.resolveReady()
    const facade = new runtime.SourceSessions(h.original)
    facade.attach(apiWith({ sourceReadingAnchor: async () => ({ ok: true, value: { sourceMessageId: 'visible-79' } }),
      sourceHistoryWindowPage: async () => ({ ok: true, value: windowValue(
        Array.from({ length: 80 }, (_, index) => locatedEvent(index)), { hasMoreAfter: false }) }) }))
    const reference = facade.retain(h.id, { source: 'mainView' })
    await reference.ready
    const session = reference.binding.session as SessionFace & SourceViewportSession
    if (mode === 'window') await session.loadThrough(900 as SessionSeq)
    let visible = [74, 79]
    const stop = session.registerWindowReader!({ available: () => true, read: () => {
      const entries = reference.binding.eventSource.getSnapshot().entries
      const seq = (source: number) => entries.find(row =>
        (row as unknown as { source?: { messageId: string } }).source?.messageId === `visible-${source}`)?.event.seq
      return { firstSeq: Number(seq(visible[0]!)), lastSeq: Number(seq(visible[1]!)), followingTail: true }
    } })
    try {
      const binding = reference.binding
      // Many tool source rows can share one short folded process block. Their
      // arrival cannot prove that the currently measured text left the screen.
      for (let burst = 0; burst < 2; burst++) {
        for (let index = 80 + burst * 20; index < 100 + burst * 20; index++) {
          const row = locatedEvent(index)
          h.eventSource.append({ ...row, event: { ...row.event, type: 'tool/call', data: { callId: `call-${index}` } } } as SessionEventLikeEntry)
        }
        await Promise.resolve(); await Promise.resolve()
        const ids = sourceIdentities(reference.binding.eventSource)
        for (let index = 74; index < 80; index++) assert.ok(ids.includes(`visible-${index}`),
          'a source-row count must not evict the last measured readable interval')
        assert.equal(ids.at(-1), `visible-${99 + burst * 20}`, 'new live rows still reach the retained tail')
        assert.equal(reference.binding, binding)
        assert.equal(session.getSnapshot().hasMore, true)
      }
      visible = [116, 119]
      h.eventSource.append(locatedEvent(120))
      await Promise.resolve(); await Promise.resolve()
      const ids = sourceIdentities(reference.binding.eventSource)
      assert.equal(ids.includes('visible-74'), false, 'a later measured viewport releases its previous reading range')
      assert.equal(ids.at(-1), 'visible-120')
      assert.ok(ids.length <= 12, 'retention remains local after layout advances')
    } finally { stop(); reference.release(); facade.dispose() }
  })
}

test('following-tail viewport retains a small source interval while continuous live rows advance', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(94), tail: Array.from({ length: 100 }, (_, index) => locatedEvent(index)) })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith())
  const reference = facade.retain(h.id, { source: 'mainView' })
  await reference.ready
  const session = reference.binding.session as SessionFace & SourceViewportSession
  const stop = session.registerWindowReader!({ available: () => true, read: () => {
    const entries = reference.binding.eventSource.getSnapshot().entries
    return { firstSeq: Number(entries.at(-4)!.event.seq), lastSeq: Number(entries.at(-1)!.event.seq), followingTail: true }
  } })
  try {
    for (let next = 100; next < 160; next++) {
      h.eventSource.append(locatedEvent(next))
      await Promise.resolve(); await Promise.resolve()
      const ids = sourceIdentities(reference.binding.eventSource)
      assert.equal(ids.length, 11, 'four measured rows, the incoming row and six older overscan rows')
      assert.equal(ids.at(-1), `visible-${next}`)
      assert.equal(ids[0], `visible-${next - 10}`)
    }
  } finally { stop(); reference.release(); facade.dispose() }
})

test('tail retention preserves measured readable overscan independently of folded live source rows', async () => {
  const tail = Array.from({ length: 1000 }, (_, index) => {
    const row = locatedEvent(index)
    return { ...row, event: { ...row.event, type: index % 10 === 0 ? 'assistant/message' : 'tool/call' } } as SessionEventLikeEntry
  })
  const h = harness({ id: sourceId(101), tail })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith())
  const reference = facade.retain(h.id, { source: 'mainView' })
  await reference.ready
  const session = reference.binding.session as SessionFace & SourceViewportSession
  const stop = session.registerWindowReader!({ available: () => true,
    read: () => ({ firstSeq: 800, lastSeq: 990, followingTail: true, overscan: { firstSeq: 690, lastSeq: 990 } }) })
  try {
    for (let index = 1000; index < 1020; index++) {
      const row = locatedEvent(index)
      h.eventSource.append({ ...row, event: { ...row.event, type: 'tool/call' } } as SessionEventLikeEntry)
      await Promise.resolve(); await Promise.resolve()
      const retained = reference.binding.eventSource.getSnapshot().entries
      assert.ok(retained.filter(row => row.event.type === 'assistant/message').length * 20 > 600,
        'folded live source rows cannot consume the measured readable height above the viewport')
      assert.ok(retained.length < 400)
      assert.equal(retained.at(-1)!.event.seq, index)
    }
    assert.equal(session.getSnapshot().hasMore, true)
  } finally { stop(); reference.release(); facade.dispose() }
})

for (const releasePage of ['move', 'hide', 'unregister'] as const) {
  test(`an older page keeps its readable beginning until its reader releases it (${releasePage})`, async () => {
    const tail = Array.from({ length: 20 }, (_, index) => {
      const row = locatedEvent(100 + index)
      return { ...row, event: { ...row.event, seq: DISPLAY_SEQ_OFFSET + index } } as SessionEventLikeEntry
    })
    const h = harness({ id: sourceId(98), tail })
    h.resolveReady()
    const facade = new runtime.SourceSessions(h.original)
    const fetched: SessionEventLikeEntry[] = []
    let failNextPage = false
    facade.attach(apiWith({ sourceHistoryWindowPage: async request => {
      if (failNextPage) throw new Error('page temporarily unavailable')
      const values: Array<{ type: string; data: Record<string, unknown>; source: number }> = []
      values.push({ type: 'assistant/message', source: 0, data: { turn: 1, step: 1,
        message: { id: 'older-commentary', role: 'assistant', content: [{ type: 'text', text: 'Earlier readable commentary' }] } } })
      // The same folded process contains many distinct tool source rows after
      // the older text. Source-group count is not rendered history progress.
      for (let index = 1; index < 80; index++) {
        const callId = `call-${Math.ceil(index / 2)}`, step = Math.ceil(index / 2) + 1
        if (index % 2) {
          values.push({ type: 'assistant/message', source: index, data: { turn: 1, step,
            message: { id: `tool-message-${index}`, role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'tool', arguments: '{}' }] } } })
          values.push({ type: 'tool/call', source: index, data: { turn: 1, step, callId, name: 'tool', arguments: '{}' } })
        } else values.push({ type: 'tool/result', source: index, data: { turn: 1, step,
          message: { id: `result-${index}`, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'done' }] } } })
      }
      values.forEach((value, index) => fetched.push({ type: 'event',
        source: { messageId: `page-${value.source}`, at: value.source, seq: value.source, epoch: 7 },
        event: { type: value.type, seq: request.endSeq! - values.length + index, time: value.source, data: value.data },
      } as unknown as SessionEventLikeEntry))
      return { ok: true, value: windowValue(fetched, { epoch: 7, before: { at: 0, seq: 0 }, beforeMessageId: 'page-0' }) }
    } }))
    const reference = facade.retain(h.id, { source: 'mainView' })
    await reference.ready
    const session = reference.binding.session as SessionFace & SourceViewportSession
    let visible = [100, 103], available = true
    const reader = { available: () => available,
      read: () => {
        const rows = reference.binding.eventSource.getSnapshot().entries
        const seq = (id: number) => rows.find(row =>
          (row as unknown as { source?: { messageId: string } }).source?.messageId === `visible-${id}`)?.event.seq
        return { firstSeq: Number(seq(visible[0]!)), lastSeq: Number(seq(visible[1]!)), followingTail: false }
      } }
    let stop = session.registerWindowReader!(reader)
    try {
      await session.loadOlder()
      const retained = reference.binding.eventSource.getSnapshot().entries
      assert.equal(retained[0], fetched[0], 'the fetched readable prefix must survive its own commit')
      assert.deepEqual(retained.slice(0, fetched.length), fetched, 'publish the contiguous bounded page until the next viewport measurement')
      assert.ok(retained.includes(tail[0]!), 'the official prepend anchor remains resident')
      assert.ok(retained.includes(tail[3]!))
      assert.equal(session.getSnapshot().hasMore, true)
      const reviseResident = async (index: number): Promise<void> => {
        const row = tail[3]!
        h.eventSource.append({ ...row, event: { ...row.event, seq: DISPLAY_SEQ_OFFSET + 20 + index } } as SessionEventLikeEntry)
        await Promise.resolve(); await Promise.resolve()
      }
      await reviseResident(0)
      assert.ok(reference.binding.eventSource.getSnapshot().entries.includes(fetched[0]!),
        'a live resident revision must not discard the received page while DOM still reports the old reader boundaries')
      failNextPage = true
      await assert.rejects(session.loadOlder(), /temporarily unavailable/)
      await reviseResident(1)
      assert.ok(reference.binding.eventSource.getSnapshot().entries.includes(fetched[0]!),
        'a failed successor page and repeated unchanged measurements cannot release the last received page')
      if (releasePage === 'move') visible = [101, 102]
      else if (releasePage === 'unregister') {
        stop()
        stop = session.registerWindowReader!({ ...reader })
      } else {
        available = false
        await reviseResident(2)
        available = true
      }
      await reviseResident(3)
      assert.equal(reference.binding.eventSource.getSnapshot().entries.includes(fetched[0]!), false,
        'reader movement, hiding or unregistration releases the old page protection')
    } finally { stop(); reference.release(); facade.dispose() }
  })
}

test('a pending page survives an extended trailing span, changed geometry overscan and an empty forward repair', async () => {
  const tail = Array.from({ length: 20 }, (_, index) => {
    const row = locatedEvent(100 + index)
    return { ...row, event: { ...row.event, seq: DISPLAY_SEQ_OFFSET + index } } as SessionEventLikeEntry
  })
  const h = harness({ id: sourceId(99), tail })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  facade.attach(apiWith({ sourceHistoryWindowPage: async request => {
    if (request.afterSeq !== undefined) return { ok: true, value: windowValue([], { after: null, hasMoreAfter: false }) }
    const records = Array.from({ length: 20 }, (_, index) => {
      const row = locatedEvent(index)
      return { ...row, event: { ...row.event, seq: request.endSeq! - 20 + index } } as SessionEventLikeEntry
    })
    return { ok: true, value: windowValue(records, { before: { at: 0, seq: 0 }, beforeMessageId: 'visible-0' }) }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  await reference.ready
  const session = reference.binding.session as SessionFace & SourceViewportSession & { loadAfter(): Promise<boolean> }
  let first = 100, last = 103, overscanFirst = 18
  const stop = session.registerWindowReader!({ available: () => true, read: () => {
    const rows = reference.binding.eventSource.getSnapshot().entries
    const seq = (id: number) => rows.find(row =>
      (row as unknown as { source?: { messageId: string } }).source?.messageId === `visible-${id}`)?.event.seq
    const overscan = seq(overscanFirst)
    return { firstSeq: Number(seq(first)), lastSeq: Number(seq(last)), followingTail: false,
      ...(overscan === undefined ? {} : { overscan: { firstSeq: Number(overscan), lastSeq: Number(seq(last)) } }) }
  } })
  try {
    await session.loadOlder()
    const revise = async (index: number) => {
      const row = tail[9]!
      h.eventSource.append({ ...row, event: { ...row.event, seq: DISPLAY_SEQ_OFFSET + 20 + index } } as SessionEventLikeEntry)
      await Promise.resolve(); await Promise.resolve()
    }
    last = 104
    await revise(0)
    assert.ok(sourceIdentities(reference.binding.eventSource).includes('visible-0'),
      'a folded step can extend its trailing source dependency without moving the leading reading boundary')
    overscanFirst = 19
    await revise(1)
    assert.ok(sourceIdentities(reference.binding.eventSource).includes('visible-0'),
      'a layout-only geometry margin change cannot count as reader movement and release the pending page')
    assert.equal(await session.loadAfter(), false)
    assert.ok(sourceIdentities(reference.binding.eventSource).includes('visible-0'),
      'empty forward exhaustion must not trim the previously received page with unprotected reader pins')
    first = 101
    await revise(2)
    assert.equal(sourceIdentities(reference.binding.eventSource).includes('visible-0'), false)
  } finally { stop(); reference.release(); facade.dispose() }
})

test('viewport eviction preserves source cursors for complete backward and forward traversal', { timeout: 5_000 }, async () => {
  const h = harness({ id: sourceId(95), tail: Array.from({ length: 100 }, (_, index) => locatedEvent(index, 42)) })
  h.resolveReady()
  const facade = new runtime.SourceSessions(h.original)
  const requests: SourceHistoryWindowRequest[] = []
  facade.attach(apiWith({ sourceHistoryWindowPage: async request => {
    requests.push(request)
    const backward = request.beforeSeq !== undefined
    const edge = reference.binding.eventSource.getSnapshot().entries.map(row =>
      (row as unknown as { source: { messageId: string; seq: number; epoch: number } }).source)
      .find(source => source.seq === (backward ? request.beforeSeq : request.afterSeq))!
    assert.deepEqual([request.epoch, request.cursorMessageId], [edge.epoch, edge.messageId],
      'eviction must carry the retained source row revision into its new boundary')
    const epoch = 100 + requests.length
    const first = backward ? Math.max(0, request.beforeSeq! - 20) : request.afterSeq! + 1
    const last = backward ? request.beforeSeq! - 1 : Math.min(100, first + 19)
    const start = backward ? request.endSeq! - (last - first + 1) : request.startSeq!
    const records = Array.from({ length: last - first + 1 }, (_, index) => {
      const row = locatedEvent(first + index, epoch)
      return { ...row, event: { ...row.event, seq: start + index } } as SessionEventLikeEntry
    })
    return { ok: true, value: windowValue(records, { before: { at: first, seq: first }, after: { at: last, seq: last },
      epoch, beforeMessageId: `visible-${first}`, afterMessageId: `visible-${last}`,
      hasMoreBefore: first > 0, hasMoreAfter: last < 100 }) }
  } }))
  const reference = facade.retain(h.id, { source: 'mainView' })
  await reference.ready
  const session = reference.binding.session as SessionFace & SourceViewportSession & { loadAfter(): Promise<boolean> }
  let visible = ['visible-40', 'visible-43']
  let windowChanged = false
  const unwatch = reference.binding.eventSource.subscribe(() => { windowChanged = true })
  const stop = session.registerWindowReader!({ available: () => true, read: () => {
    assert.equal(windowChanged, false, 'sample visible pins before publishing the new source window, not from stale DOM afterward')
    const rows = reference.binding.eventSource.getSnapshot().entries
    const seqOf = (id: string) => Number(rows.find(row => (row as unknown as { source: { messageId: string } }).source.messageId === id)!.event.seq)
    return { firstSeq: seqOf(visible[0]!), lastSeq: seqOf(visible[1]!), followingTail: false }
  } })
  try {
    h.eventSource.append(locatedEvent(100, 42))
    await Promise.resolve(); await Promise.resolve()
    const seen = new Set(sourceIdentities(reference.binding.eventSource))
    // A wheel burst can request another page before the compositor moves the
    // original reading rows. Both successful pages must extend the source
    // edge rather than immediately evicting the newly fetched prefix.
    for (let page = 0; page < 2; page++) {
      const before = sourceIdentities(reference.binding.eventSource)
      windowChanged = false
      await session.loadOlder()
      const after = sourceIdentities(reference.binding.eventSource)
      after.forEach(id => seen.add(id))
      assert.notEqual(after[0], before[0], 'each accepted history request extends the edge while the viewport stays still')
      assert.ok(visible.every(id => after.includes(id)), 'the stationary viewport remains protected')
    }
    for (let page = 0; page < 30 && session.getSnapshot().hasMore; page++) {
      const before = sourceIdentities(reference.binding.eventSource)
      visible = before.slice(0, 2)
      windowChanged = false
      await session.loadOlder()
      const after = sourceIdentities(reference.binding.eventSource)
      after.forEach(id => seen.add(id))
      assert.notEqual(after[0], before[0], 'backward paging must advance the retained source edge')
      assert.ok(visible.every(id => after.includes(id)), 'the old visible source rows survive prepend')
    }
    assert.equal(sourceIdentities(reference.binding.eventSource)[0], 'visible-0')
    visible = sourceIdentities(reference.binding.eventSource).slice(-2)
    for (let page = 0; page < 2; page++) {
      const before = sourceIdentities(reference.binding.eventSource)
      windowChanged = false
      assert.equal(await session.loadAfter(), true)
      const after = sourceIdentities(reference.binding.eventSource)
      after.forEach(id => seen.add(id))
      assert.notEqual(after.at(-1), before.at(-1), 'a second forward request also advances while the viewport stays still')
      assert.ok(visible.every(id => after.includes(id)))
    }
    for (let page = 0; page < 40; page++) {
      const before = sourceIdentities(reference.binding.eventSource)
      visible = before.slice(-2)
      windowChanged = false
      if (!await session.loadAfter()) break
      const after = sourceIdentities(reference.binding.eventSource)
      after.forEach(id => seen.add(id))
      assert.notEqual(after.at(-1), before.at(-1), 'forward paging must advance the retained source edge')
      assert.ok(visible.every(id => after.includes(id)), 'the old visible source rows survive append')
    }
    assert.equal(sourceIdentities(reference.binding.eventSource).at(-1), 'visible-100')
    assert.equal(seen.size, 101, 'every source row is reachable after locality eviction')
    assert.ok(requests.some(request => request.beforeSeq !== undefined) && requests.some(request => request.afterSeq !== undefined))
  } finally { unwatch(); stop(); reference.release(); facade.dispose() }
})
