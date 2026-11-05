/** Bounded native IndexedDB check on an isolated synthetic origin. No Host or
 * native agent is contacted. Uses the existing webshot browser runtime. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/home/chris/.cache/ms-playwright'
const { chromium } = await import(pathToFileURL(process.env.HAPI_DSH_PLAYWRIGHT ?? '/home/chris/.agents/tools/webshot/node_modules/playwright/index.mjs').href)
const bundle = await build({ entryPoints: ['src/client/remote-outbox.ts'], bundle: true, platform: 'browser', format: 'iife', globalName: 'Operations', write: false })
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/operations.js' ? 'application/javascript' : 'text/html')
  response.end(request.url === '/operations.js' ? bundle.outputFiles[0].text : '<script src="/operations.js"></script>')
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
let browser
try {
  browser = await chromium.launch({ headless: true, timeout: 10_000 })
  const context = await browser.newContext(), a = await context.newPage(), b = await context.newPage()
  const origin = `http://127.0.0.1:${server.address().port}`
  await Promise.all([a.goto(origin), b.goto(origin)])
  await a.evaluate(() => {
    window.calls = 0
    window.session = { id: 'hhpi:machine:source:codex:thread', status: 'running', activeTurnId: 'original', pendingRequests: [], capabilities: { send: true, steer: true, cancel: true, approve: true, files: false } }
    window.operation = { sessionId: session.id, operationId: 'native-idb-race', kind: 'steer', turnId: 'original', text: 'Synthetic intent' }
    window.outbox = new Operations.RemoteOutbox(async request => { calls++; return new Promise(resolve => { window.ack = () => resolve({ ...request, status: 'accepted', message: 'Synthetic ACK' }) }) })
    outbox.setStorage({ storage: localStorage, scope: 'synthetic-idb' }); outbox.enqueue(operation); outbox.start(operation.operationId); outbox.acceptCatalog([session])
  })
  await a.waitForFunction(() => calls === 1)
  const fixture = await a.evaluate(() => ({ session, operation }))
  await b.evaluate(({ session, operation }) => {
    window.calls = 0; window.lookups = 0
    window.outbox = new Operations.RemoteOutbox(async request => { calls++; return { ...request, status: 'accepted', message: 'Unexpected second dispatch' } }, async () => { lookups++; return null })
    outbox.setStorage({ storage: localStorage, scope: 'synthetic-idb' }); outbox.acceptCatalog([session])
    window.operation = operation
  }, fixture)
  await b.waitForFunction(() => lookups === 1)
  assert.equal(await b.evaluate(() => calls), 0, 'a missing receipt never authorizes a second native dispatch')
  await b.evaluate(() => outbox.observe(operation.sessionId, [{ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: { source: { rpcId: operation.operationId } } } }]))
  await a.evaluate(() => ack())
  await a.waitForFunction(() => outbox.get(operation.operationId) === undefined)
  assert.equal(await a.evaluate(() => localStorage.length), 0, 'an old ACK cannot recreate the journal after native observation')
  await b.reload()
  assert.equal(await b.evaluate(() => localStorage.length), 0)
  await context.close()
  console.log('PASS native IndexedDB: two tabs, one dispatch, missing receipt does not resend, native observation defeats late ACK and reload.')
} finally { await browser?.close(); server.close(); await once(server, 'close') }
