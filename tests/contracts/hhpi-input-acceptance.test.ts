/** Real pinned InputHub -> SessionInputShell/Lexical -> ConversationController.
 * Only the Session's local admission/storage and prompt endpoints are fixtures. */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import type { SessionBinding, SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { prepareOfficialBrowserLibrary, resolveOfficialBrowserDependency } from './official-browser-library.ts'

const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '../..')
type Shell = SessionInput & {
  snapshot: ReturnType<SessionInput['state']['getSnapshot']>
  editor: { setRootElement(root: HTMLElement): void }
  notices: { getSnapshot(): { level: string; text: string } | null }
  dispose(): readonly string[]
}
type Hub = { shellFor(binding: SessionBinding): Shell }
type Official = {
  InputHub: new (ctx: Context, translate: (key: string) => string) => Hub
  ConversationController: new (ctx: Context, config: object) => object
}
let official: Official | undefined
async function loadOfficial(): Promise<Official> {
  if (official) return official
  const source = process.env.HHPI_DSH_SOURCE
  assert.ok(source, 'This contract requires the prepared pinned DSH source graph.')
  const provenance = JSON.parse(readFileSync(resolve(source, 'hhpi-source-inputs.json'), 'utf8'))
  assert.equal(provenance.upstreamCommit, '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db')
  assert.ok(provenance.inputs.some((input: { path: string }) => input.path === 'source-snapshots/dsh-ext/source.patch'))
  await prepareOfficialBrowserLibrary()
  const result = await build({
    stdin: { contents: [
      `export { InputHub } from ${JSON.stringify(resolve(source, 'packages/client/ui-conversation/src/client/input/hub.ts'))};`,
      `export { ConversationController } from ${JSON.stringify(resolve(source, 'packages/client/ui-conversation/src/client/service.ts'))};`,
    ].join('\n'), loader: 'ts', resolveDir: root },
    nodePaths: [resolve(source, 'packages/client/ui-conversation/node_modules'), resolve(source, 'node_modules'), resolve(root, 'node_modules')],
    external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime'],
    bundle: true, platform: 'node', conditions: ['development'], format: 'cjs', target: 'node24', jsx: 'automatic', write: false,
    outfile: resolve(source, '.hhpi-input-acceptance-contract.js'),
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
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })

async function fixture(t: TestContext, options: { quota?: number; acceptEarly?: boolean } = {}) {
  const { JSDOM } = require('jsdom') as typeof import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div contenteditable="true"></div></body></html>', {
    url: 'https://synthetic.invalid/', pretendToBeVisual: true, storageQuota: options.quota ?? 4096,
  })
  // jsdom has no Range layout. These tests assert semantic draft retention,
  // not selection geometry or browser scrolling.
  Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new dom.window.DOMRect() })
  Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  const restores: (() => void)[] = []
  for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'localStorage', 'getComputedStyle', 'DOMRect', 'Range']) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(dom.window, key) })
    restores.push(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key) })
  }
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    dom.window.close()
    for (const restore of restores.reverse()) restore()
  })
  const { InputHub, ConversationController } = await loadOfficial()
  const gate = deferred<{ ok: true; value: { accepted: true } }>(), prompted = deferred<void>()
  const admissions: string[] = [], prompts: unknown[] = [], revisions: string[] = []
  const emptyStore = { getSnapshot: () => undefined, subscribe: () => () => {} }
  let nextId = 0
  const session = {
    sessionId: 'synthetic-input',
    projections: { faceOf: () => emptyStore },
    getSnapshot: () => ({ sessionId: 'synthetic-input', blank: false, running: false, subagent: null }),
    beginSubmission(input: { text: string; onAccept?: () => void }) {
      const requestId = `operation-${++nextId}`
      // The browser's real Storage quota fails synchronously inside the real
      // async ConversationController.sendSession; no manufactured throw.
      dom.window.localStorage.setItem(requestId, input.text)
      admissions.push(input.text)
      if (options.acceptEarly) input.onAccept?.()
      return { requestId, abandon() { dom.window.localStorage.removeItem(requestId) } }
    },
    prompt(...args: unknown[]) { prompts.push(args); prompted.resolve(); return gate.promise },
  } as unknown as SessionFace
  const binding = { session, sessionId: session.sessionId, ctx } as SessionBinding
  ctx.reflect.provide('sessions', { sessionOf: () => session, binding: () => binding } as unknown as Context['sessions'])
  const hub = new InputHub(ctx, key => key)
  new ConversationController(ctx, { input: hub, blocks: { storeFor: () => emptyStore }, maxConcurrentFileUploads: 1 })
  const shell = hub.shellFor(binding)
  // The actual Lexical root is mounted, so assertions also inspect the editor DOM.
  shell.editor.setRootElement(dom.window.document.querySelector('[contenteditable]') as HTMLElement)
  shell.state.subscribe(() => { revisions.push(shell.state.getSnapshot().draft) })
  return { ctx, dom, shell, gate, prompted: prompted.promise, admissions, prompts, revisions }
}

test('official composer never clears on local Storage quota refusal and allows a corrected retry', { timeout: 15000 }, async t => {
  const f = await fixture(t, { quota: 48 })
  const text = '原始草稿不能先消失。'.repeat(20)
  f.shell.setDraft(text)
  f.shell.submit('queue')
  assert.equal(f.shell.snapshot.draft, text)
  assert.equal(f.dom.window.document.querySelector('[contenteditable]')!.textContent, text)
  await flush()
  assert.equal(f.shell.snapshot.draft, text)
  assert.ok(f.revisions.every(draft => draft === text), 'no transient empty draft can reach autosave')
  assert.equal(f.shell.notices.getSnapshot()?.level, 'error')
  assert.equal(f.admissions.length, 0)
  assert.equal(f.prompts.length, 0)
  f.shell.setDraft('保留后重试')
  f.shell.submit('queue')
  await f.prompted
  assert.deepEqual(f.admissions, ['保留后重试'])
  assert.equal(f.shell.snapshot.draft, '保留后重试')
  f.gate.resolve({ ok: true, value: { accepted: true } })
  await flush()
  assert.equal(f.shell.snapshot.draft, '')
})

test('native composer serializes clicks and keeps an unaccepted draft read-only until settlement', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.shell.setDraft('发送的正文')
  f.shell.submit('queue', 'click')
  f.shell.submit('queue', 'click')
  assert.equal(f.shell.snapshot.phase, 'sending')
  assert.equal(f.shell.snapshot.draft, '发送的正文')
  await f.prompted
  assert.deepEqual(f.admissions, ['发送的正文'])
  assert.equal(f.prompts.length, 1)
  f.gate.resolve({ ok: true, value: { accepted: true } })
  await flush()
  assert.equal(f.shell.snapshot.draft, '')
  assert.equal(f.shell.snapshot.phase, 'plain')
})

test('durable onAccept commits before paint and a late result cannot clear the next draft', { timeout: 15000 }, async t => {
  const f = await fixture(t, { acceptEarly: true })
  f.shell.setDraft('already safely saved')
  f.shell.submit('queue', 'click')
  assert.equal(f.shell.snapshot.draft, '')
  assert.deepEqual(f.admissions, ['already safely saved'])
  assert.equal(f.prompts.length, 0)
  f.shell.setDraft('the next draft')
  await f.prompted
  f.gate.reject(new Error('late transport failure after acceptance'))
  await flush()
  assert.equal(f.shell.snapshot.draft, 'the next draft')
})

test('a delayed successful acknowledgement preserves voice text added after its captured draft', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.shell.setDraft('captured message')
  f.shell.submit('queue', 'click')
  await f.prompted
  // Public editor mutation models a queued IME/dictation or plugin update.
  // This is real Lexical content, not a claim about physical speech hardware.
  f.shell.setDraft('captured message new dictated words')
  f.gate.resolve({ ok: true, value: { accepted: true } })
  await flush()
  assert.equal(f.shell.snapshot.draft, ' new dictated words')
  assert.equal(f.dom.window.document.querySelector('[contenteditable]')!.textContent, ' new dictated words')
})

test('an acknowledgement never clears a rewritten draft', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.shell.setDraft('captured message')
  f.shell.submit('queue', 'click')
  await f.prompted
  f.shell.setDraft('a replacement dictated phrase')
  f.gate.resolve({ ok: true, value: { accepted: true } })
  await flush()
  assert.equal(f.shell.snapshot.draft, 'a replacement dictated phrase')
})

test('a failed send retains the captured message and later dictated text', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.shell.setDraft('captured message')
  f.shell.submit('queue', 'click')
  await f.prompted
  f.shell.setDraft('captured message new dictated words')
  f.gate.reject(new Error('source did not accept'))
  await flush()
  assert.equal(f.shell.snapshot.draft, 'captured message new dictated words')
})

test('equal visible prefix text cannot conceal a changed semantic quote from an old acknowledgement', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  assert.equal(f.shell.insertQuote('captured quote'), true)
  const captured = f.shell.snapshot.draft
  f.shell.submit('queue', 'click')
  await f.prompted
  f.shell.setDraft(captured + ' new text')
  f.gate.resolve({ ok: true, value: { accepted: true } })
  await flush()
  assert.equal(f.shell.snapshot.draft, captured + ' new text', 'the replaced quote is no longer the captured prefix')
})

test('disposing the native composer ignores late settlement', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.shell.setDraft('still owned until accepted')
  f.shell.submit('queue')
  await f.prompted
  f.shell.dispose()
  const before = f.revisions.length
  f.gate.resolve({ ok: true, value: { accepted: true } })
  await flush()
  assert.equal(f.revisions.length, before)
})
