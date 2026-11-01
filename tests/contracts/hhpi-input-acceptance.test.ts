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
  assert.equal(provenance.upstreamCommit, '1f81c047fc48fa190a683e469daa699857e9afe8')
  assert.ok(provenance.inputs.some((input: { path: string }) => input.path === 'scripts/dsh-ext/input-acceptance.mjs'))
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

async function fixture(t: TestContext, options: { policy?: 'after-acceptance'; quota?: number; disabled?: boolean } = { policy: 'after-acceptance' }) {
  const { JSDOM } = require('jsdom') as typeof import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div contenteditable="true"></div></body></html>', {
    url: 'https://synthetic.invalid/', pretendToBeVisual: true, storageQuota: options.quota ?? 4096,
  })
  const restores: (() => void)[] = []
  for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'localStorage', 'getComputedStyle', 'DOMRect', 'Range']) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(dom.window, key) })
    restores.push(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key) })
  }
  const flag = Object.getOwnPropertyDescriptor(globalThis, '__DSH_CLIENT_INPUT_ACCEPTANCE')
  Object.defineProperty(globalThis, '__DSH_CLIENT_INPUT_ACCEPTANCE', { configurable: true, value: options.disabled ? 'off' : undefined })
  restores.push(() => { if (flag) Object.defineProperty(globalThis, '__DSH_CLIENT_INPUT_ACCEPTANCE', flag); else Reflect.deleteProperty(globalThis, '__DSH_CLIENT_INPUT_ACCEPTANCE') })
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
    sessionId: 'synthetic-input', ...options.policy === undefined ? {} : { inputCommitPolicy: options.policy },
    projections: { faceOf: () => emptyStore },
    getSnapshot: () => ({ sessionId: 'synthetic-input', blank: false, running: false }),
    beginSubmission(input: { text: string }) {
      const requestId = `operation-${++nextId}`
      // The browser's real Storage quota fails synchronously inside the real
      // async ConversationController.sendSession; no manufactured throw.
      dom.window.localStorage.setItem(requestId, input.text)
      admissions.push(input.text)
      return { requestId, abandon() { dom.window.localStorage.removeItem(requestId) } }
    },
    prompt(...args: unknown[]) { prompts.push(args); prompted.resolve(); return gate.promise },
  } as unknown as SessionFace
  const binding = { session, sessionId: session.sessionId, ctx } as SessionBinding
  ctx.reflect.provide('sessions', { sessionOf: () => session, binding: () => binding } as unknown as Context['sessions'])
  const hub = new InputHub(ctx, key => key)
  new ConversationController(ctx, { input: hub, blocks: {}, maxConcurrentFileUploads: 1 })
  const shell = hub.shellFor(binding)
  // The actual Lexical root is mounted, so assertions also inspect the editor DOM.
  shell.editor.setRootElement(dom.window.document.querySelector('[contenteditable]') as HTMLElement)
  shell.state.subscribe(() => { revisions.push(shell.state.getSnapshot().draft) })
  return { ctx, dom, shell, gate, prompted: prompted.promise, admissions, prompts, revisions }
}

test('official composer never clears on local Storage quota refusal and allows a corrected retry', { timeout: 15000 }, async t => {
  const f = await fixture(t, { policy: 'after-acceptance', quota: 48 })
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

test('official composer serializes double clicks and retains text typed during durable acceptance', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.shell.setDraft('发送的正文')
  f.shell.submit('queue', 'click')
  f.shell.submit('queue', 'click')
  assert.equal(f.shell.snapshot.phase, 'plain', 'the editor remains editable')
  assert.equal(f.shell.snapshot.draft, '发送的正文')
  f.shell.setDraft('发送的正文\n继续输入')
  f.shell.submit('queue', 'click')
  await f.prompted
  assert.deepEqual(f.admissions, ['发送的正文'])
  assert.equal(f.prompts.length, 1)
  assert.equal(f.dom.window.localStorage.getItem('operation-1'), '发送的正文')
  f.gate.resolve({ ok: true, value: { accepted: true } })
  await flush()
  assert.equal(f.shell.snapshot.draft, '\n继续输入')
  assert.equal(f.dom.window.document.querySelector('[contenteditable]')!.textContent, '继续输入')
})

test('official composer keeps a replacement draft on successful or rejected admission', { timeout: 15000 }, async t => {
  for (const accepted of [true, false]) {
    await t.test(accepted ? 'success' : 'failure', async child => {
      const f = await fixture(child)
      f.shell.setDraft('original')
      f.shell.submit('queue')
      await f.prompted
      f.shell.setDraft('改写后的草稿')
      if (accepted) f.gate.resolve({ ok: true, value: { accepted: true } })
      else f.gate.reject(new Error('local admission refused'))
      await flush()
      assert.equal(f.shell.snapshot.draft, '改写后的草稿')
      assert.equal(f.dom.window.document.querySelector('[contenteditable]')!.textContent, '改写后的草稿')
      assert.ok(f.revisions.every(draft => draft !== ''))
    })
  }
})

test('ordinary native DSH and the explicit disable switch retain optimistic input behavior', { timeout: 15000 }, async t => {
  for (const options of [{}, { policy: 'after-acceptance' as const, disabled: true }]) {
    await t.test(options.disabled ? 'disabled' : 'default', async child => {
      const f = await fixture(child, options)
      f.shell.setDraft('first')
      f.shell.submit('queue')
      assert.equal(f.shell.snapshot.draft, '')
      f.shell.setDraft('second')
      f.shell.submit('queue')
      assert.equal(f.shell.snapshot.draft, '')
      assert.deepEqual(f.admissions, ['first', 'second'])
      f.gate.resolve({ ok: true, value: { accepted: true } })
      await flush()
    })
  }
})

test('disposing an opted-in official composer ignores late acceptance', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.shell.setDraft('still owned by the editor until accepted')
  f.shell.submit('queue')
  await f.prompted
  f.shell.dispose()
  const before = f.revisions.length
  f.gate.resolve({ ok: true, value: { accepted: true } })
  await flush()
  assert.equal(f.revisions.length, before, 'a late accepted sink cannot publish into a disposed Pane')
})

test('official composer retains unresolved attachments and references on admission failure', { timeout: 15000 }, async t => {
  await t.test('attachment-only refusal keeps the rail and later typing', async child => {
    const f = await fixture(child)
    const id = 'unresolved-image' as Parameters<SessionInput['addAttachments']>[0][number]
    f.shell.addAttachments([id])
    f.shell.submit('queue')
    assert.deepEqual(f.shell.snapshot.attachmentIds, [id])
    f.shell.setDraft('继续输入')
    await flush()
    assert.equal(f.shell.snapshot.draft, '继续输入')
    assert.deepEqual(f.shell.snapshot.attachmentIds, [id])
    assert.equal(f.admissions.length, 0)
  })
  await t.test('missing reference owner retains the semantic draft without calling the sink', async child => {
    const f = await fixture(child)
    f.shell.setDraft('@ref')
    assert.equal(f.shell.insertReference({ source: 'missing', ref: 'ref-id', label: 'Reference', clipboardText: '@reference' },
      { start: 0, end: 4, draftRev: f.shell.snapshot.draftRev }), true)
    const before = f.shell.snapshot
    f.shell.submit('queue')
    assert.equal(f.shell.snapshot.draft, before.draft)
    await flush()
    assert.equal(f.shell.snapshot.draft, before.draft)
    assert.deepEqual(f.shell.snapshot.occurrences, before.occurrences)
    assert.equal(f.admissions.length, 0)
  })
})

test('accepted reference serialization cannot clear a replacement chip with the same displayed text', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const controller = { lexicon: { getSnapshot: () => new Map(), subscribe: () => () => {} }, track() {},
    serializeReference: async (_source: string, ref: string) => `serialized:${ref}` }
  f.ctx.reflect.provide('inputTriggers', { sessionOf: () => controller } as never)
  const insert = (ref: string) => {
    f.shell.setDraft('@ref')
    assert.equal(f.shell.insertReference({ source: 'reference', ref, label: 'Reference', clipboardText: '@reference' },
      { start: 0, end: 4, draftRev: f.shell.snapshot.draftRev }), true)
  }
  insert('original')
  f.shell.submit('queue')
  await f.prompted
  insert('replacement')
  const before = f.shell.snapshot.draft
  f.gate.resolve({ ok: true, value: { accepted: true } })
  await flush()
  assert.deepEqual(f.admissions, ['serialized:original'])
  assert.equal(f.shell.snapshot.draft, before)
  assert.equal(f.shell.snapshot.occurrences[0]?.ref, 'replacement')
})
