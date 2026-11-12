import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts'
import type { HhpiCatalogCapability, HhpiCatalogCapabilityStore } from '../src/client/remote-sessions.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
interface Runtime {
  RemoteSessions: new (ctx: Context, original: ISessions, api: HhpiRemoteApi) => {
    readonly list: { getSnapshot(): ISessions['list'] extends { getSnapshot(): infer T } ? T : never; subscribe(listener: () => void): () => void }
    readonly capabilities: HhpiCatalogCapabilityStore
    refresh(): Promise<void>
    retain(id: string, options: { source: 'hapiWorkspace' }): SessionReference
    dispose(): void
  }
}

let runtime: Runtime
before(async () => {
  const source = join(root, 'src/client/remote-sessions.ts')
  const contract = join(root, 'tests/fixtures/client-session-contract.ts')
  const built = await build({ stdin: { contents: `export { RemoteSessions } from ${JSON.stringify(source)}`, resolveDir: root, loader: 'ts' },
    alias: { '@deepseek-ai/dsh-api-session-controller/client': contract }, external: ['@deepseek-ai/cordis'],
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent' })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0]!.text)(require, module, module.exports)
  runtime = module.exports as Runtime
})

function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    set(next: T) { value = next; for (const listener of listeners) listener() } }
}

function metadata(): SourceSession {
  const identity = { machineId: 'machine-one', sourceId: 'codex-native', engine: 'codex', nativeId: 'native-thread-one' }
  return { ...identity, id: sourceSessionId(identity), title: 'Synthetic native thread', cwd: '/workspace', updatedAt: 1,
    status: 'idle', activeTurnId: null, capabilities: { send: true, steer: true, cancel: true, approve: false, files: false }, pendingRequests: [] }
}

function emptyChanges(): ReturnType<HhpiRemoteApi['changes']> {
  return { [Symbol.asyncIterator]: async function* () {}, send() { throw new Error('Source changes are read only') }, end() {}, dispose() {} }
}

test('the session list stays pending until the first HHPI catalog result publishes source metadata', async () => {
  const source = metadata()
  let answer!: (value: Awaited<ReturnType<HhpiRemoteApi['catalog']>>) => void
  const catalog = new Promise<Awaited<ReturnType<HhpiRemoteApi['catalog']>>>(resolve => { answer = resolve })
  const api: HhpiRemoteApi = {
    catalog: () => catalog,
    read: async request => ({ ok: true, value: { session: source, epoch: 'epoch-one', version: 1, entries: [], before: null, after: null, hasBefore: false, hasAfter: false, context: [] } }),
    changes: emptyChanges, operate: async () => { throw new Error('not used') }, create: async () => { throw new Error('not used') }, resource: async () => { throw new Error('not used') },
  }
  const originalList = store({ ids: [], byId: {}, phase: 'ready' as const, projectionsBySession: {} })
  const original = { list: originalList, windowCommit: {}, searchResultLimit: 100,
    refresh: async () => {}, retainInfo: () => store({ referenceCount: 0, retainedBy: {} }) } as unknown as ISessions
  const ctx = new Context(), remote = new runtime.RemoteSessions(ctx, original, api)
  let retained: SessionReference | undefined
  let retaining = false
  const stop = remote.list.subscribe(() => {
    const snapshot = remote.list.getSnapshot()
    if (snapshot.phase === 'ready' && snapshot.ids.includes(source.id as never) && !retaining) {
      retaining = true
      retained = remote.retain(source.id, { source: 'hapiWorkspace' })
    }
  })
  try {
    assert.equal(remote.list.getSnapshot().phase, 'pending')
    assert.equal(remote.capabilities.getSnapshot().catalogReady, false)
    answer({ ok: true, value: { protocol: 1, legacyHapi: false, sessions: [source], sources: [] } })
    await remote.refresh()
    assert.equal(remote.list.getSnapshot().phase, 'ready')
    assert.ok(remote.list.getSnapshot().ids.includes(source.id as never))
    const row = remote.list.getSnapshot().byId[source.id as never]
    assert.ok(row)
    assert.deepEqual(row.projectionValues, { hhpiSource: source, hhpiDiscovery: 'advertised', subagentCatalog: [] }, 'the advertised row must carry native machine/engine identity for workspace migration')
    assert.ok(retained, 'a source row listener can retain the just-advertised source in the same publication')
    assert.deepEqual(remote.capabilities.getSnapshot(), { catalogReady: true, legacyHapi: false })
  } finally {
    stop(); retained?.release(); remote.dispose(); await ctx.fiber.dispose()
  }
})

test('retired display rows stay hidden even if an old server advertises compatibility', async () => {
  const nativeDisplay = `hapi-codex-${'a'.repeat(32)}`
  const observedDisplay = `hapi-observed-${'b'.repeat(32)}-r2`
  const ordinaryDsh = 'native-session-from-dsh'
  const unknownBusinessId = 'hapi-codex-business-record'
  const ids = [nativeDisplay, observedDisplay, ordinaryDsh, unknownBusinessId]
  const makeOriginal = (): ISessions => ({
    list: store({ ids, byId: Object.fromEntries(ids.map(id => [id, { id, title: id, displayTitle: id, cwd: '/', running: false, retainedBy: {}, blank: false, updatedAt: 0 }])),
      phase: 'ready' as const, projectionsBySession: Object.fromEntries(ids.map(id => [id, { values: {}, explicit: {} }])) }),
    windowCommit: {}, refresh: async () => {}, retainInfo: () => store({ referenceCount: 0, retainedBy: {} }),
  } as unknown as ISessions)
  const makeApi = (legacyHapi: boolean): HhpiRemoteApi => ({
    catalog: async () => ({ ok: true, value: { protocol: 1, legacyHapi, sessions: [], sources: [] } }),
    read: async () => { throw new Error('not used') }, changes: emptyChanges, operate: async () => { throw new Error('not used') },
    create: async () => { throw new Error('not used') }, resource: async () => { throw new Error('not used') },
  })
  const hhpiContext = new Context(), hhpiOriginal = makeOriginal()
  const hhpi = new runtime.RemoteSessions(hhpiContext, hhpiOriginal, makeApi(false))
  try {
    const initial = hhpi.list.getSnapshot()
    assert.equal(initial.phase, 'ready', 'usable ordinary DSH rows must not wait for the first native catalog')
    assert.equal(hhpi.capabilities.getSnapshot().catalogReady, false, 'usable ordinary rows do not mean that native discovery has settled')
    assert.ok(initial.ids.includes(ordinaryDsh as never))
    assert.equal(initial.ids.includes(nativeDisplay as never), false, 'retired identities are hidden before catalog settlement too')
    assert.equal(initial.ids.includes(observedDisplay as never), false)
    await hhpi.refresh()
    const snapshot = hhpi.list.getSnapshot()
    assert.equal(snapshot.ids.includes(nativeDisplay as never), false)
    assert.equal(snapshot.ids.includes(observedDisplay as never), false)
    assert.equal(snapshot.byId[nativeDisplay as never], undefined)
    assert.equal(snapshot.projectionsBySession[nativeDisplay as never], undefined)
    assert.ok(snapshot.ids.includes(ordinaryDsh as never), 'ordinary DSH sessions remain visible')
    assert.ok(snapshot.ids.includes(unknownBusinessId as never), 'unrecognized business IDs are not reclassified')
  } finally { hhpi.dispose(); await hhpiContext.fiber.dispose() }

  const compatibilityContext = new Context(), compatibilityOriginal = makeOriginal()
  const compatibility = new runtime.RemoteSessions(compatibilityContext, compatibilityOriginal, makeApi(true))
  try {
    await compatibility.refresh()
    const snapshot = compatibility.list.getSnapshot()
    assert.equal(snapshot.ids.includes(nativeDisplay as never), false)
    assert.equal(snapshot.ids.includes(observedDisplay as never), false)
    assert.ok(snapshot.ids.includes(ordinaryDsh as never))
  } finally { compatibility.dispose(); await compatibilityContext.fiber.dispose() }
})
