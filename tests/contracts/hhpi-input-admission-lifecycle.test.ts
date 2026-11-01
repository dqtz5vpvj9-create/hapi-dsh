/** Real pinned input/controller, official persisted store and production draft autosave.
 * Only the Session's durable admission and native prompt are protocol fixtures. */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import type { SessionBinding, SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { DraftSnapshot, InputActions, SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ComposerAutosaves, composerDraftKey } from '../../src/client/composer-autosave.ts'
import { prepareOfficialBrowserLibrary, resolveOfficialBrowserDependency } from './official-browser-library.ts'

const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '../..')
type Shell = SessionInput & {
  snapshot: ReturnType<SessionInput['state']['getSnapshot']>
  actions: InputActions
  editor: { setRootElement(root: HTMLElement | null): void }
  bindDraftPersistence(write: (draft: DraftSnapshot) => void): () => void
  persistCurrentDraft(): void
}
type Scope = { ctx: Context; fiber: { dispose(): Promise<unknown> } }
type Official = {
  InputHub: new (ctx: Context, translate: (key: string) => string) => { shellFor(binding: SessionBinding): Shell }
  ConversationController: new (ctx: Context, config: object) => object
  createScope(ctx: Context, sessionId: SessionFace['sessionId']): Scope
  createConversationStore(): { create(key: string): { actions: { setDraft(draft: DraftSnapshot): void } } }
  readConversationDraft(key: string): DraftSnapshot
}
let official: Official | undefined
async function loadOfficial(): Promise<Official> {
  if (official) return official
  const source = process.env.HHPI_DSH_SOURCE
  assert.ok(source, 'This contract requires the prepared pinned DSH source graph.')
  const provenance = JSON.parse(readFileSync(resolve(source, 'hhpi-source-inputs.json'), 'utf8'))
  assert.equal(provenance.upstreamCommit, '1f81c047fc48fa190a683e469daa699857e9afe8')
  assert.ok(provenance.inputs.some((input: { path: string }) => input.path === 'scripts/dsh-ext/input-acceptance.mjs'))
  await prepareOfficialBrowserLibrary()
  const result = await build({
    stdin: { contents: [
      `export { InputHub } from ${JSON.stringify(resolve(source, 'packages/client/ui-conversation/src/client/input/hub.ts'))};`,
      `export { ConversationController } from ${JSON.stringify(resolve(source, 'packages/client/ui-conversation/src/client/service.ts'))};`,
      `export { createConversationStore, readConversationDraft } from ${JSON.stringify(resolve(source, 'packages/client/ui-conversation/src/client/stores.ts'))};`,
      `export { createScope } from ${JSON.stringify(resolve(source, 'packages/api/session-controller/src/client/scope.ts'))};`,
    ].join('\n'), loader: 'ts', resolveDir: root },
    nodePaths: [resolve(source, 'packages/client/ui-conversation/node_modules'), resolve(source, 'node_modules'), resolve(root, 'node_modules')],
    external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime'],
    bundle: true, platform: 'node', conditions: ['development'], format: 'cjs', target: 'node24', jsx: 'automatic', write: false,
    outfile: resolve(source, '.hhpi-input-admission-lifecycle-contract.js'),
    loader: { '.css': 'css', '.module.css': 'local-css' }, logLevel: 'silent',
  })
  const output = result.outputFiles.find(file => file.path.endsWith('.js'))
  assert.ok(output)
  const module = { exports: {} as Official }
  new Function('require', 'module', 'exports', output.text)(resolveOfficialBrowserDependency, module, module.exports)
  official = module.exports
  return official
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })

async function fixture(t: TestContext) {
  const { JSDOM } = require('jsdom') as typeof import('jsdom')
  const quota = 4096
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://synthetic.invalid/', pretendToBeVisual: true, storageQuota: quota,
  })
  const restores: (() => void)[] = []
  for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'localStorage', 'getComputedStyle', 'DOMRect', 'Range']) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(dom.window, key) })
    restores.push(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key) })
  }
  const flag = Object.getOwnPropertyDescriptor(globalThis, '__DSH_CLIENT_INPUT_ACCEPTANCE')
  Object.defineProperty(globalThis, '__DSH_CLIENT_INPUT_ACCEPTANCE', { configurable: true, value: undefined })
  restores.push(() => { if (flag) Object.defineProperty(globalThis, '__DSH_CLIENT_INPUT_ACCEPTANCE', flag); else Reflect.deleteProperty(globalThis, '__DSH_CLIENT_INPUT_ACCEPTANCE') })
  const ctx = new Context(), autosaves = new ComposerAutosaves()
  const api = await loadOfficial(), errors: unknown[] = []
  const gate = deferred<{ ok: true; value: { accepted: true } }>(), prompted = deferred<void>()
  const admissions: string[] = [], prompts: unknown[][] = []
  const emptyStore = { getSnapshot: () => undefined, subscribe: () => () => {} }
  let nextId = 0, beforeAdmission: (() => void) | undefined, active: Pane | undefined
  const session = {
    sessionId: 'synthetic-admission', inputCommitPolicy: 'after-acceptance',
    projections: { faceOf: () => emptyStore },
    getSnapshot: () => ({ sessionId: 'synthetic-admission', blank: false, running: false }),
    beginSubmission(input: { text: string }) {
      const requestId = `operation-${++nextId}`
      dom.window.localStorage.setItem(requestId, JSON.stringify(input))
      admissions.push(input.text)
      beforeAdmission?.()
      return { requestId, admitted: true as const, abandon() { dom.window.localStorage.removeItem(requestId) } }
    },
    prompt(...args: unknown[]) { prompts.push(args); prompted.resolve(); return gate.promise },
  } as unknown as SessionFace
  ctx.reflect.provide('sessions', {
    sessionOf: (scope: Context) => active?.binding.ctx === scope ? session : undefined,
    bindingOf: (scope: Context) => active?.binding.ctx === scope ? active.binding : undefined,
    binding: () => active?.binding,
  } as unknown as Context['sessions'])
  const hub = new api.InputHub(ctx, key => key)
  new api.ConversationController(ctx, { input: hub, blocks: {}, maxConcurrentFileUploads: 1 })
  const viewId = 'synthetic-pane', storeKey = JSON.stringify([session.sessionId, viewId])
  const draftKey = composerDraftKey('synthetic-host', storeKey)
  type Pane = { shell: Shell; binding: SessionBinding; element: HTMLElement; close(): Promise<unknown> }
  function open(): Pane {
    assert.equal(active, undefined, 'close the previous binding before opening a new generation')
    const scope = api.createScope(ctx, session.sessionId)
    const binding = { session, sessionId: session.sessionId, viewId, ctx: scope.ctx } as SessionBinding
    const shell = hub.shellFor(binding)
    const element = dom.window.document.createElement('div')
    element.contentEditable = 'true'; dom.window.document.body.appendChild(element)
    shell.editor.setRootElement(element)
    // The same public writer boundary used by DefaultConversationViews, backed
    // by the real official store; no fixture writes its persistence format.
    const store = api.createConversationStore().create(storeKey)
    const unbind = shell.bindDraftPersistence(draft => store.actions.setDraft(draft))
    shell.persistCurrentDraft()
    const stop = autosaves.retain({ key: draftKey, storage: dom.window.localStorage, composer: shell,
      actions: shell.actions, report: error => errors.push(error) })
    let closed: Promise<unknown> | undefined
    const pane: Pane = { shell, binding, element, close() {
      if (closed) return closed
      stop(); unbind(); shell.editor.setRootElement(null); element.remove()
      if (active === pane) active = undefined
      closed = scope.fiber.dispose()
      return closed
    } }
    active = pane
    return pane
  }
  t.after(async () => {
    gate.resolve({ ok: true, value: { accepted: true } })
    await active?.close()
    await ctx.fiber.dispose()
    dom.window.close()
    for (const restore of restores.reverse()) restore()
  })
  return {
    open, gate, admissions, prompts, prompted: prompted.promise, errors,
    beforeAdmission(callback: () => void) { beforeAdmission = callback },
    officialDraft: () => api.readConversationDraft(storeKey).text,
    savedDraft: () => JSON.parse(dom.window.localStorage.getItem(draftKey)!).draft.text as string,
    fillStorage() {
      let used = 0
      for (let index = 0; index < dom.window.localStorage.length; index++) {
        const key = dom.window.localStorage.key(index)!
        used += key.length + dom.window.localStorage.getItem(key)!.length
      }
      dom.window.localStorage.setItem('quota-filler', 'x'.repeat(quota - used - 'quota-filler'.length))
      return () => dom.window.localStorage.removeItem('quota-filler')
    },
  }
}

test('durable admission clears both real draft stores before paint and close/reopen cannot resurrect the sent draft', { timeout: 15000 }, async t => {
  for (const success of [true, false]) {
    await t.test(success ? 'late success' : 'late failure', async child => {
      const f = await fixture(child), first = f.open()
      const sent = '弱网下已安全保存的消息'
      first.shell.setDraft(sent)
      assert.equal(f.officialDraft(), sent); assert.equal(f.savedDraft(), sent)
      first.shell.submit('queue')
      assert.deepEqual(f.admissions, [sent])
      assert.equal(f.prompts.length, 0, 'close in the real pre-nextPaint window')
      assert.equal(first.shell.snapshot.draft, '')
      assert.equal(f.officialDraft(), ''); assert.equal(f.savedDraft(), '')
      await first.close()
      const reopened = f.open()
      assert.equal(reopened.shell.snapshot.draft, '')
      // Identical text in a new input generation is still a new draft.
      reopened.shell.setDraft(sent)
      await f.prompted
      if (success) f.gate.resolve({ ok: true, value: { accepted: true } })
      else f.gate.reject(new Error('late transport failure after local admission'))
      await flush()
      assert.equal(reopened.shell.snapshot.draft, sent)
      assert.equal(reopened.element.textContent, sent)
      assert.equal(f.officialDraft(), sent); assert.equal(f.savedDraft(), sent)
      assert.deepEqual(f.errors, [])
    })
  }
})

test('the admission callback and later settlement preserve a replacement draft revision even when its text matches', { timeout: 15000 }, async t => {
  const f = await fixture(t), first = f.open(), sent = '同样的文字也是新的草稿'
  first.shell.setDraft(sent)
  const revision = first.shell.snapshot.draftRev
  f.beforeAdmission(() => {
    first.shell.setDraft('用户先修改这一版')
    first.shell.setDraft(sent)
  })
  first.shell.submit('queue')
  assert.deepEqual(f.admissions, [sent])
  assert.ok(first.shell.snapshot.draftRev > revision)
  assert.equal(first.shell.snapshot.draft, sent, 'admission belongs to the captured revision, not matching text')
  assert.equal(f.officialDraft(), sent); assert.equal(f.savedDraft(), sent)
  assert.equal(f.prompts.length, 0)
  await first.close()
  const reopened = f.open()
  assert.equal(reopened.shell.snapshot.draft, sent)
  await f.prompted
  f.gate.resolve({ ok: true, value: { accepted: true } })
  await flush()
  assert.equal(reopened.shell.snapshot.draft, sent)
  assert.equal(f.officialDraft(), sent); assert.equal(f.savedDraft(), sent)
  assert.deepEqual(f.errors, [])
})

test('actual Storage quota refusal preserves both draft stores through immediate close and late failure cannot erase a new edit', { timeout: 15000 }, async t => {
  const f = await fixture(t), first = f.open(), draft = '没有保存成功的消息必须保留'
  first.shell.setDraft(draft)
  const freeStorage = f.fillStorage()
  first.shell.submit('queue')
  assert.deepEqual(f.admissions, []); assert.deepEqual(f.prompts, [])
  assert.equal(first.shell.snapshot.draft, draft)
  assert.equal(f.officialDraft(), draft); assert.equal(f.savedDraft(), draft)
  await first.close()
  const reopened = f.open()
  assert.equal(reopened.shell.snapshot.draft, draft)
  freeStorage()
  const edited = '重新打开后继续编辑'
  reopened.shell.setDraft(edited)
  await flush()
  assert.equal(reopened.shell.snapshot.draft, edited)
  assert.equal(reopened.element.textContent, edited)
  assert.equal(f.officialDraft(), edited); assert.equal(f.savedDraft(), edited)
  assert.deepEqual(f.admissions, []); assert.deepEqual(f.prompts, [])
  assert.deepEqual(f.errors, [])
})
