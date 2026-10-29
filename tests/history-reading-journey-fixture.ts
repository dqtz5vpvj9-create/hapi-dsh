/** Real source projection/feed/facade/Conversation; only remote paging and the
 * operation binding are fixtures. No browser layout or native execution runs. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { ISessions, SessionBinding, SessionEventChange, SessionEventLikeEntry, SessionReference, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NativeProjector } from '../src/codex/projector.ts'
import type { NativeRow } from '../src/codex/native.ts'
import { toSourceFrames } from '../src/shared/source-frame-builder.ts'
import { SourceFrameFeed } from '../src/shared/source-frame-feed.ts'
import type { SourceFrame, SourceWindowProgress } from '../src/shared/source-frames.ts'
import type { SourceSessionsApi, SourceViewportSession } from '../src/client/source-sessions.ts'
import type { SourceHistoryWindowRequest, SourceHistoryWindowValue } from '../src/source-window-types.ts'
import { officialChat } from './official-conversation-fixture.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const contractEvents = join(dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json')), 'lib/types/client/contract/events.js')
type Runtime = typeof import('../src/client/source-sessions.ts') & typeof import('../src/client/seamless/controller.ts')
  & Pick<typeof import('@deepseek-ai/dsh-api-session-controller/client'), 'MutableSessionEventSource'>
let runtime: Promise<Runtime> | undefined
const fault = process.env.HAPI_DSH_HISTORY_FAULT

function loadRuntime(): Promise<Runtime> {
  return runtime ??= (async () => {
    const built = await build({
      stdin: { contents: [
        `export { SourceSessions } from ${JSON.stringify(join(root, 'src/client/source-sessions.ts'))}`,
        `export { historyWindowProgressed, probeHistoryWindow } from ${JSON.stringify(join(root, 'src/client/seamless/controller.ts'))}`,
        "export { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'",
      ].join('\n'), resolveDir: root, sourcefile: 'history-reading-journey-entry.ts', loader: 'ts' },
      alias: { '@deepseek-ai/dsh-api-session-controller/client': join(root, 'tests/fixtures/client-session-contract.ts') },
      define: { process: 'undefined' }, bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false, logLevel: 'silent',
      plugins: fault ? [{ name: 'history-regression-in-memory', setup(builder) {
        builder.onLoad({ filter: /(?:source-sessions|source-window-store|source-event-feed|controller)\.ts$/ }, async ({ path }) => {
          let contents = await readFile(path, 'utf8')
          if (fault === 'short-client-page' && path.endsWith('/client/source-sessions.ts')) {
            const current = 'limit: limit ?? SOURCE_HISTORY_PAGE_SIZE }'
            assert.ok(contents.includes(current), 'page-size fault must match the bounded interactive page seam')
            contents = contents.replace(current, 'limit: limit ?? 20 }')
          } else if (fault === 'replace-on-prepend' && path.endsWith('/client/source-event-feed.ts')) {
            const current = 'this.source.prepend(additions, hasMore)'
            assert.ok(contents.includes(current), 'prepend fault must match the source page publication seam')
            contents = contents.replace(current, 'this.source.replace(entries, hasMore)')
          } else if (fault === 'evict-resident-history' && path.endsWith('/client/source-window-store.ts')) {
            const current = 'this.rows = [...byKey.values()]'
            assert.ok(contents.includes(current), 'eviction fault must match the canonical resident-row store')
            contents = contents.replace(current,
              "this.rows = batch.kind === 'merge' ? [...byKey.values()].slice(-100) : [...byKey.values()]")
          }
          return { contents, loader: 'ts' }
        })
      } }] : [],
    })
    return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`)
  })()
}

export function nativeTurn(turn: number, start: number, tools: number): NativeRow[] {
  const base = (seq: number) => ({ key: `item-${seq}`, rowId: `row-${seq}`, localId: `local-${seq}`, seq,
    createdAt: seq, sourceAt: seq, fingerprint: `version-${seq}`,
    execution: { threadId: 'journey-thread', turnId: `turn-${turn}`, itemId: `item-${seq}` } })
  const rows: NativeRow[] = [{ ...base(start), kind: 'user', text: `Question ${turn}`, invoked: true, mode: 'queue', parts: [] }]
  for (let index = 0; index < tools; index++) {
    const seq = start + 1 + index * 2, callId = `turn-${turn}-tool-${index}`
    rows.push({ ...base(seq), kind: 'tool-call', callId, name: 'read', input: { path: `/synthetic/file-${index}` } },
      { ...base(seq + 1), kind: 'tool-result', callId, output: `Synthetic file ${index}`, isError: false })
  }
  rows.push({ ...base(start + tools * 2 + 1), kind: 'assistant', text: `Answer ${turn}`, reasoning: false, final: true },
    { ...base(start + tools * 2 + 2), kind: 'turn', execution: { ...base(start).execution,
      turn: { started: true, ended: true, status: 'completed' } } })
  return rows
}

function project(rows: readonly NativeRow[]): SourceFrame[] {
  const projector = NativeProjector.history({ model: () => 'fixture', provider: () => 'fixture',
    submittedMessage: () => undefined, stream: () => {} })
  // Match the actual Host page renderer: a clipped source interval must not
  // invent a turn start before the user input that a later page will deliver.
  if (rows[0]?.kind !== 'user' || !rows[0].invoked || rows[0].mode === 'steer') projector.setSuppressFirstTurnStart()
  projector.apply(rows)
  return toSourceFrames({ events: projector.historySeed(), eventSources: projector.eventSources()!,
    turnAnchors: projector.turnAnchorEntries(), stepAnchors: projector.stepAnchorEntries() })
}

function snapshot(sessionId: SessionId): SessionSnapshot {
  return { sessionId, pendingSubmissions: [], running: false, subagent: null, removed: false,
    openState: 'open', openError: null, hasMore: true, loadingOlder: false, promptError: null,
    blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false }
}

export async function readingJourney(tailTools = 80, turnCount = 12, initialTailRows?: number) {
  const runtime = await loadRuntime(), id = 'hapi-codex-00000000000000000000000000000071' as SessionId
  const turns = Array.from({ length: turnCount }, (_, index) => nativeTurn(index + 1, (index + 1) * 1000,
    index === turnCount - 1 ? tailTools : 8))
  const rows = turns.flat(), baselineRows = turns.at(-1)!, reads: SourceHistoryWindowRequest[] = []
  const current = project(initialTailRows === undefined ? baselineRows : baselineRows.slice(-initialTailRows))
  const feed = new SourceFrameFeed(() => ({ kind: 'replace', frames: current, hasMoreBefore: true }))
  const source = new runtime.MutableSessionEventSource()
  source.replace([], false)
  const operation = { sessionId: id, projections: { faceOf: () => ({ getSnapshot: () => [], subscribe: () => () => {} }) },
    getSnapshot: () => snapshot(id), subscribe: () => () => {},
    loadOlder: async () => { throw new Error('source history must not page the operation Session') },
    loadThrough: async () => { throw new Error('source history must navigate source identities') },
  }
  const binding = { sessionId: id, eventSource: source, ctx: {}, session: operation } as unknown as SessionBinding
  const original = { retain: () => ({ sessionId: id, binding, ready: Promise.resolve(binding), release() {} }),
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }), subscribe: () => () => {} }),
    binding: () => binding,
  } as unknown as ISessions
  const page = (selected: readonly NativeRow[]): SourceHistoryWindowValue => {
    assert.ok(selected.length, 'fixture must return an actual source interval')
    const first = selected[0]!, last = selected.at(-1)!
    return { records: [], frames: project(selected), before: { at: first.sourceAt!, seq: first.seq! },
      after: { at: last.sourceAt!, seq: last.seq! }, beforeMessageId: first.rowId, afterMessageId: last.rowId,
      hasMoreBefore: rows[0]!.seq! < first.seq!, hasMoreAfter: rows.at(-1)!.seq! > last.seq!, epoch: 1 }
  }
  const api: SourceSessionsApi = {
    sourceWindowFollow(request, signal) { assert.equal(request.sessionId, id); assert.ok(signal); return feed.watch(signal) },
    sourceHistoryOutline: async () => ({ ok: true, value: { entries: [], seedIndex: 0, firstTurn: 0, complete: true } }),
    sourceHistoryOutlinePage: async () => ({ ok: true, value: { entries: [], seedIndex: 0, firstTurn: 0, complete: true, hasMore: false } }),
    sourceHistoryHead: async () => ({ ok: true, value: { messageId: rows.at(-1)!.rowId, at: rows.at(-1)!.sourceAt!, seq: rows.at(-1)!.seq! } }),
    async sourceHistoryWindowPage(request) {
      assert.equal(request.sessionId, id); reads.push({ ...request })
      let selected: NativeRow[]
      if (request.beforeSeq !== undefined) selected = rows.filter(row => row.seq! < request.beforeSeq!).slice(-(request.limit ?? 500))
      else if (request.afterSeq !== undefined) selected = rows.filter(row => row.seq! > request.afterSeq!).slice(0, request.limit ?? 500)
      else {
        const index = rows.findIndex(row => row.rowId === request.messageId)
        assert.ok(index >= 0, 'context must identify an actual source message')
        selected = rows.slice(Math.max(0, index - (request.radius ?? 50)), index + (request.radius ?? 50) + 1)
      }
      return { ok: true, value: page(selected) }
    },
  }
  const facade = new runtime.SourceSessions(original); facade.attach(api)
  const reference: SessionReference = facade.retain(id, { source: 'mainView' }); await reference.ready
  const session = reference.binding!.session as typeof operation & SourceViewportSession & { loadAfter(): Promise<boolean>; returnToLive(): Promise<boolean> }
  const entries = () => [...reference.binding!.eventSource.getSnapshot().entries]
  const bodyTexts = () => entries().flatMap(entry => {
    const data = entry.event.data as { content?: Array<{ type: string; text?: string }>; message?: { content: Array<{ type: string; text?: string }> } }
    return (entry.event.type === 'user/message' ? data.content : entry.event.type === 'assistant/message' ? data.message?.content : [])
      ?.flatMap(part => part.type === 'text' ? [part.text!] : []) ?? []
  })
  const textEntry = (text: string) => entries().find(entry => {
    const data = entry.event.data as { content?: Array<{ text?: string }>; message?: { content: Array<{ text?: string }> } }
    return (data.content ?? data.message?.content)?.some(part => part.text === text)
  })!
  const sourceIds = () => new Set(entries().flatMap(entry => (entry as SessionEventLikeEntry & { source?: { messageId: string } }).source?.messageId ?? []))
  const chat = officialChat(); chat.assembler.activateTarget('chat')
  const eventSource = reference.binding!.eventSource, changes: SessionEventChange[] = []
  chat.assembler.replaceWindow(entries().flatMap(entry => entry.type === 'event' ? [entry] : []), session.getSnapshot().hasMore)
  chat.assembler.flush()
  const stopConversation = eventSource.subscribe(() => {
    const window = eventSource.getSnapshot(), change = window.change
    changes.push(change)
    assert.notEqual(change.kind, 'settle-assistant', 'the synthetic history contains only completed source messages')
    if (change.kind === 'settle-assistant') return
    const delta = change.entries.flatMap(entry => entry.type === 'event' ? [entry] : [])
    assert.equal(delta.length, change.entries.length, 'the synthetic history has no transient frames')
    if (change.kind === 'prepend') chat.assembler.prepend(delta, window.hasMore)
    else if (change.kind === 'append') for (const entry of delta) chat.assembler.append(entry)
    else chat.assembler.replaceWindow(delta, window.hasMore)
    chat.assembler.flush()
  })
  const renderedTexts = () => {
    const snapshot = chat.assembler.snapshot('chat')
    return snapshot.order.flatMap(key => {
      const data = snapshot.nodes.get(key)?.data
      return [...(data?.content ?? []), ...(data?.blocks ?? [])].flatMap(block => typeof block.text === 'string' ? [block.text] : [])
    })
  }
  const renderedNode = (text: string) => {
    const snapshot = chat.assembler.snapshot('chat')
    return snapshot.order.map(key => snapshot.nodes.get(key)!).find(node =>
      [...(node.data.content ?? []), ...(node.data.blocks ?? [])].some(block => block.text === text))
  }
  const renderedNodes = () => {
    const snapshot = chat.assembler.snapshot('chat')
    return snapshot.order.map(key => snapshot.nodes.get(key)!)
  }
  // A collapsed/virtualized viewport can keep these two outer rows while the
  // actual source window and official Conversation above admit more content.
  const outerDom = { querySelectorAll: () => ['folded-current-process', 'current-answer'].map(key => ({
    getAttribute: () => key, closest: () => null,
  })) } as unknown as HTMLElement
  const probe = () => ({ ...runtime.probeHistoryWindow(outerDom, 'folded-current-process'),
    source: session.sourceWindow.getSnapshot() as SourceWindowProgress })
  const appendRemote = (next: NativeRow[]) => { rows.push(...next) }
  return { id, session, reference, binding: reference.binding, entries, bodyTexts, textEntry, sourceIds, renderedTexts, renderedNode, renderedNodes, changes,
    reads, rows, turns, baselineRows, probe, progressed: runtime.historyWindowProgressed,
    appendRemote, async close() { stopConversation(); reference.release(); facade.dispose(); feed.dispose(); await chat.close() } }
}
