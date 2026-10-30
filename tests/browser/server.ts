/** Isolated loopback IO fixture; real source index, no profiles or credentials. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { SourceEventIndex, type EventInput } from '../../src/remote/event-index.ts'
import { sourceSessionId, type SourceSession, type SourceReadRequest, type SourceChangesRequest, type SourceOperation } from '../../src/remote/protocol.ts'
import { output } from './build.mjs'

export async function startLab() {
  const identity = { machineId: 'browser-fixture', sourceId: 'native-fixture', engine: 'codex', nativeId: 'synthetic-only' }
  const metadata: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic browser acceptance', cwd: '/synthetic', updatedAt: 1000, status: 'idle', activeTurnId: null,
    capabilities: { send: true, steer: true, cancel: true, approve: true, files: false }, pendingRequests: [] }
  type EventAudit = { eventId: string; type: string; userMessageId?: string; toolLifecycleId?: string }
  type ReadAudit = {
    ordinal: number
    request: { before: number | null; after: number | null; around: number | null; limit: number }
    page: { before: number | null; after: number | null; hasBefore: boolean; hasAfter: boolean }
    eventCount: number
    contextEventSeqs: number[]
    events: Array<EventAudit & { seq: number }>
    userMessageIds: string[]
    toolLifecycleIds: string[]
    toolLifecycleCount: number
    typeCounts: Record<string, number>
  }
  let index: SourceEventIndex
  let reads = 0, writes: SourceOperation[] = [], failNext = false
  let readPages: ReadAudit[] = [], eventAudit = new Map<number, EventAudit>()
  const connections = new Set<AbortController>()
  function reset(): void {
    for (const abort of connections) abort.abort()
    connections.clear(); index?.dispose()
    index = new SourceEventIndex(':memory:', metadata); reads = 0; writes = []; failNext = false
    readPages = []; eventAudit = new Map()
    const put = (key: string, event: EventInput, audit: EventAudit): void => {
      const seq = index.put(key, event)
      eventAudit.set(Number(seq), audit)
    }
    const putToolLifecycle = (block: number, time: number): void => {
      const rootCallId = `browser-tool-root-${block}`
      const innerCallId = `browser-tool-inner-${block}`
      const lifecycleId = rootCallId
      const turn = block + 1
      const add = (suffix: string, type: string, data: Record<string, unknown>, surfaceOp?: 'append'): void => {
        put(`tool-${block}-${suffix}`, { type, time, data, ...(surfaceOp ? { surfaceOp } : {}) } as EventInput,
          { eventId: `tool-${block}-${suffix}`, type, toolLifecycleId: lifecycleId })
      }
      add('turn-start', 'turn/start', { turn })
      add('step-start', 'step/start', { turn, step: 1 })
      add('advertisement', 'assistant/message', {
        turn, step: 1, stream: [], message: { id: `tool-advertisement-${block}`, role: 'assistant',
          source: { kind: 'model', provider: 'fixture', model: 'fixture' },
          content: [{ type: 'tool-call', id: rootCallId, name: 'run_code', arguments: '{}' }] },
      }, 'append')
      add('call', 'tool/call', { turn, step: 1, callId: rootCallId, name: 'run_code', arguments: '{}' })
      add('ptc-start', 'tool/ptc-dispatch-start', {
        rootCallId, parentCallId: rootCallId, subCallId: innerCallId, name: 'read', arguments: { path: `fixture-${block}.txt` },
      })
      add('ptc-result', 'tool/ptc-dispatch', {
        rootCallId, parentCallId: rootCallId, subCallId: innerCallId, name: 'read', arguments: { path: `fixture-${block}.txt` },
        isError: false, content: [{ type: 'text', text: `read complete ${block}` }],
      })
      add('result', 'tool/result', { turn, step: 1, message: {
        id: `tool-result-${block}`, role: 'tool', toolCallId: rootCallId,
        source: { kind: 'tool', callId: rootCallId }, content: [{ type: 'text', text: `run complete ${block}` }], isError: false,
      } }, 'append')
      add('step-end', 'step/end', { turn, step: 1 })
      add('turn-end', 'turn/end', { turn, reason: { kind: 'completed' } })
    }
    index.edit(metadata, () => {
      let nextUserId = 1
      // The first three source windows remain user-only. The seven newest
      // 160-event windows each begin with a complete real tool/PTC lifecycle,
      // followed by 151 user messages, so every prepend exercises both paths.
      for (let block = 0; block < 3; block++) {
        const count = block < 2 ? 128 : 127
        for (let i = 0; i < count; i++, nextUserId++) {
          const id = nextUserId
          put(`item-${id}`, {
            type: 'user/message', time: id, surfaceOp: 'append', data: { id: `message-${id}`, role: 'user', source: { kind: 'user' },
              content: [{ type: 'text', text: `body-${id}  官方组件合成阅读记录 ${id}\n${'Variable length content for real wrapping and scrolling. '.repeat(1 + id % 4)}${id % 13 === 0 ? '\n' + 'long_unbroken_line_'.repeat(28) : ''}` }] },
          } as EventInput, { eventId: `message-${id}`, type: 'user/message', userMessageId: `message-${id}` })
        }
      }
      for (let block = 0; block < 7; block++) {
        putToolLifecycle(block, nextUserId)
        for (let i = 0; i < 151; i++, nextUserId++) {
          const id = nextUserId
          put(`item-${id}`, {
            type: 'user/message', time: id, surfaceOp: 'append', data: { id: `message-${id}`, role: 'user', source: { kind: 'user' },
              content: [{ type: 'text', text: `body-${id}  官方组件合成阅读记录 ${id}\n${'Variable length content for real wrapping and scrolling. '.repeat(1 + id % 4)}${id % 13 === 0 ? '\n' + 'long_unbroken_line_'.repeat(28) : ''}` }] },
          } as EventInput, { eventId: `message-${id}`, type: 'user/message', userMessageId: `message-${id}` })
        }
      }
      if (nextUserId !== 1441) throw new Error(`Synthetic history seeded ${nextUserId - 1} user messages instead of 1440.`)
    })
  }
  reset()
  let origin = ''
  async function jsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []; let bytes = 0
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 64 * 1024) throw new Error('Fixture request exceeds budget')
      chunks.push(Buffer.from(chunk))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  function json(response: ServerResponse, value: unknown, status = 200): void {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(value))
  }
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? '/', origin)
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) return json(response, { error: 'Foreign origin refused' }, 403)
    if (request.method === 'POST') {
      if (request.headers['x-hhpi-fixture'] !== '1') return json(response, { error: 'Fixture boundary required' }, 403)
      const body = await jsonBody(request)
      if (url.pathname === '/api/reset') { reset(); return json(response, { ok: true }) }
      if (url.pathname === '/api/fault') { failNext = true; return json(response, { ok: true }) }
      if (url.pathname === '/api/read') {
        const value = body as SourceReadRequest
        if (value.sessionId !== metadata.id) return json(response, { error: 'Unknown synthetic session' }, 403)
        reads++
        // Bounded IO latency makes the real pending/commit boundary observable.
        await new Promise(resolve => setTimeout(resolve, 40))
        if (failNext) { failNext = false; return json(response, { error: 'Synthetic read failure' }, 503) }
        const page = index.read(value)
        const context = new Set(page.context)
        const events = page.entries.filter(entry => !context.has(Number(entry.event.seq))).map(entry => {
          const seq = Number(entry.event.seq), audit = eventAudit.get(seq)
          if (!audit) throw new Error(`Synthetic source event ${seq} has no audit identity.`)
          return { ...audit, seq }
        })
        const typeCounts = events.reduce<Record<string, number>>((counts, event) => {
          counts[event.type] = (counts[event.type] ?? 0) + 1
          return counts
        }, {})
        const toolLifecycleIds = [...new Set(events.flatMap(event => event.toolLifecycleId ? [event.toolLifecycleId] : []))]
        readPages.push({
          ordinal: readPages.length + 1,
          request: { before: value.before ?? null, after: value.after ?? null, around: value.around ?? null, limit: value.limit ?? 160 },
          page: { before: page.before, after: page.after, hasBefore: page.hasBefore, hasAfter: page.hasAfter },
          eventCount: events.length, contextEventSeqs: page.context,
          events, userMessageIds: events.flatMap(event => event.userMessageId ? [event.userMessageId] : []),
          toolLifecycleIds, toolLifecycleCount: toolLifecycleIds.length, typeCounts,
        })
        return json(response, { ok: true, value: page })
      }
      if (url.pathname === '/api/operate') {
        const value = body as SourceOperation
        if (value.sessionId !== metadata.id || typeof value.operationId !== 'string') return json(response, { error: 'Only synthetic operations are allowed' }, 403)
        if (!writes.some(item => item.operationId === value.operationId)) writes.push(value)
        return json(response, { ok: true, value: { sessionId: metadata.id, operationId: value.operationId, status: 'accepted', message: 'Synthetic IO receipt only' } })
      }
      return json(response, { error: 'Unknown fixture operation' }, 404)
    }
    if (request.method !== 'GET') return json(response, { error: 'Method refused' }, 405)
    if (url.pathname === '/api/catalog') return json(response, { ok: true, value: { protocol: 1, legacyHapi: false, sessions: [metadata], sources: [] } })
    if (url.pathname === '/api/stats') {
      const userMessageIds = [...eventAudit.values()].flatMap(event => event.userMessageId ? [Number(event.userMessageId.slice('message-'.length))] : [])
      return json(response, {
        reads, writes, readPages, userMessageCount: userMessageIds.length,
        userMessageRange: { first: Math.min(...userMessageIds), last: Math.max(...userMessageIds) }, sourceEventCount: eventAudit.size,
      })
    }
    if (url.pathname === '/api/changes') {
      const value = JSON.parse(url.searchParams.get('request') ?? '{}') as SourceChangesRequest
      if (value.sessionId !== metadata.id) return json(response, { error: 'Unknown synthetic session' }, 403)
      const abort = new AbortController(); connections.add(abort)
      response.on('close', () => { abort.abort(); connections.delete(abort) })
      response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' }); response.flushHeaders()
      try { for await (const change of index.changes(value, abort.signal)) response.write(JSON.stringify(change) + '\n') }
      catch (error) { if (!abort.signal.aborted) throw error }
      finally { response.end(); connections.delete(abort) }
      return
    }
    const path = resolve(output, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)))
    if (!path.startsWith(output + sep)) return json(response, { error: 'Path refused' }, 403)
    try {
      if (!(await stat(path)).isFile()) return json(response, { error: 'Not a file' }, 404)
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json' }
      response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
      response.end(await readFile(path))
    } catch { json(response, { error: 'Fixture resource not found' }, 404) }
  })().catch(error => { if (!response.headersSent) json(response, { error: error instanceof Error ? error.message : String(error) }, 500); else response.destroy(error as Error) }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Loopback fixture did not bind')
  origin = `http://127.0.0.1:${address.port}`
  return { origin, async close(): Promise<void> {
    for (const abort of connections) abort.abort()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    index.dispose()
  } }
}
