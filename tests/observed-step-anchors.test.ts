/** Real observed parser/projector and canonical window with synthetic source rows. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionId, pluginRecordOf, type PluginRecordMap, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { HapiMessage, HapiTransport } from '../src/codex/contracts.ts'
import { SourceHistoryWindow, type RenderedHistoryPage } from '../src/codex/source-window.ts'
import { HapiObservedAgent } from '../src/hapi-agent/agent.ts'
import { parseObservedHistory, parseObservedMessage } from '../src/hapi-agent/parser.ts'
import { ObservedProjector } from '../src/hapi-agent/projector.ts'
import { toSourceFrames } from '../src/shared/source-frame-builder.ts'
import { SourceWindowStore } from '../src/client/source-window-store.ts'

function row(id: string, seq: number, data: Record<string, unknown>, extra: Partial<HapiMessage> = {}): HapiMessage {
  return { id, localId: null, seq, createdAt: 1000 + seq, content: { role: 'agent', content: { type: 'codex', data } }, ...extra }
}
function user(id: string, seq: number): HapiMessage {
  return row(id, seq, {}, { invokedAt: 1000 + seq, content: { role: 'user', content: { type: 'text', text: id } } })
}
const call = (id = 'call-row', seq = 2) => row(id, seq, { type: 'tool-call', callId: 'source-call', name: 'bash', input: { command: 'pwd' } })
const result = (id = 'result-row', seq = 3) => row(id, seq, { type: 'tool-call-result', callId: 'source-call', output: '/fixture' })
function render(rows: readonly HapiMessage[], turnBase = 0) {
  const frames: AssistantStreamFrame[] = []
  const projector = ObservedProjector.history({
    model: () => 'fixture', submittedMessage: () => undefined, content: () => undefined, stream: frame => { frames.push(frame) }, turnBase,
  })
  projector.apply(parseObservedHistory(rows))
  return { projector, frames, events: () => projector.historySeed() }
}
function annotations(events: readonly SessionEvent[]) {
  return events.flatMap(event => {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:hapi-dsh-observed/item'
      ? [record.data as PluginRecordMap['plugin:hapi-dsh-observed/item']] : []
  })
}
function callId(events: readonly SessionEvent[]) {
  const event = events.find(event => event.type === 'tool/call')
  assert.ok(event?.type === 'tool/call'); return event.data.callId
}
function resultId(events: readonly SessionEvent[]) {
  const event = events.find(event => event.type === 'tool/result')
  assert.ok(event?.type === 'tool/result'); return event.data.message.toolCallId
}

test('independent observed pages and the live seed share tool identity despite different local steps', () => {
  const reasoning = row('reasoning-row', 1, { type: 'reasoning', id: 'reasoning-item', message: 'Inspect the source.' })
  const answer = row('answer-row', 4, { type: 'message', message: 'Done.' })
  const left = render([reasoning, call()]), right = render([result(), answer]), seed = render([reasoning, call(), result(), answer], 500)
  const leftTool = annotations(left.events()).find(value => value.sourceRowId === 'call-row')!
  const rightTool = annotations(right.events()).find(value => value.sourceRowId === 'result-row')!
  const seedTool = annotations(seed.events()).find(value => value.sourceRowId === 'call-row')!
  assert.ok(leftTool.sourceStepId)
  assert.equal(leftTool.sourceStepId, rightTool.sourceStepId)
  assert.equal(leftTool.sourceStepId, seedTool.sourceStepId)
  const anchor = left.projector.stepAnchorEntries().get(leftTool.sourceStepId)!
  assert.deepEqual([anchor.turn, anchor.step], [1, 2])
  assert.equal(rightTool.displayStep, 1); assert.equal(seedTool.displayTurn, 501)
  assert.equal(callId(left.events()), resultId(right.events()))
  assert.equal(callId(seed.events()), resultId(right.events()))
  assert.equal(new Set(annotations(seed.events()).flatMap(value => value.sourceStepId ?? [])).size, 3)
})

test('reasoning and final SDK blocks retain distinct source steps inside the same row', () => {
  const sdk = row('sdk-row', 1, {}, { content: { role: 'agent', content: { type: 'output', data: {
    type: 'assistant', uuid: 'sdk-message', message: { content: [
      { type: 'thinking', thinking: 'Inspect the source.' }, { type: 'text', text: 'Done.' },
    ] },
  } } } })
  const page = render([sdk]), items = annotations(page.events())
  assert.equal(items.length, 2)
  assert.notEqual(items[0]!.sourceStepId, items[1]!.sourceStepId)
  assert.deepEqual(items.map(value => value.displayStep), [1, 2])
})

test('repeated progress rows keep their original tool step when rendered in separate pages', () => {
  const progress = row('progress-row', 4, { type: 'tool-call', callId: 'source-call', name: 'bash', input: { command: 'pwd' },
    progress: { content: [{ type: 'text', text: 'Still running.' }] } })
  const live = render([call()], 80)
  live.projector.apply(parseObservedMessage(progress)); live.projector.apply(parseObservedMessage(result('result-row', 5)))
  const progressPage = render([progress]), resultPage = render([result('result-row', 5)])
  assert.equal(callId(live.events()), callId(progressPage.events()))
  assert.equal(callId(live.events()), resultId(resultPage.events()))
  assert.deepEqual([...live.projector.stepAnchorEntries().keys()], [...progressPage.projector.stepAnchorEntries().keys()])
  assert.equal(live.events().filter(event => event.type === 'step/start').length, 1)
  assert.equal(live.events().filter(event => event.type === 'tool/call').length, 1)
})

test('source native turns distinguish reused tool IDs without using detached display turns', () => {
  const native = (input: HapiMessage, turnId: string): HapiMessage => {
    const content = input.content as { role: string; content: { type: string; data: Record<string, unknown> } }
    return { ...input, content: { ...content, content: { ...content.content, data: { ...content.content.data,
      nativeExecution: { threadId: 'source-thread', turnId },
    } } } }
  }
  const first = render([native(call(), 'first')]), second = render([native(call(), 'second')])
  const secondResult = render([native(result(), 'second')], 100)
  assert.notEqual(callId(first.events()), callId(second.events()))
  assert.equal(callId(second.events()), resultId(secondResult.events()))
  assert.notDeepEqual([...first.projector.stepAnchorEntries().keys()], [...second.projector.stepAnchorEntries().keys()])
})

test('a live stream and its completed detached row retain one stable step', () => {
  const stableId = 'source-message'
  const provisional = row('provisional-row', 1, { type: 'message', id: stableId, streamSnapshot: true, message: 'Partial' })
  const final = row('final-row', 2, { type: 'message', id: stableId, streamSnapshot: true, message: 'Partial answer.' }, { localId: stableId })
  const live = render([provisional], 30)
  const before = [...live.projector.stepAnchorEntries().keys()]
  live.projector.apply(parseObservedMessage(final))
  const page = render([final])
  assert.deepEqual([...page.projector.stepAnchorEntries().keys()], before)
  assert.deepEqual([...live.projector.stepAnchorEntries().keys()], before)
  assert.equal(annotations(live.events())[0]?.sourceStepId, annotations(page.events())[0]?.sourceStepId)
  for (const rendered of [live, page]) {
    const item = annotations(rendered.events())[0]!
    assert.deepEqual([item.sourceRowId, item.sourceSeq, item.sourceAt], [final.id, final.seq, final.createdAt])
  }
  assert.equal(live.events().filter(event => event.type === 'step/start').length, 1)
  assert.equal(live.frames.filter(frame => frame.type === 'start').length, 1)
})

test('user annotations report their display turn without assigning a response step', () => {
  const page = render([user('first', 1), row('answer', 2, { type: 'message', message: 'Answer.' }), user('second', 3)], 20)
  const users = annotations(page.events()).filter(value => value.sourceRowId === 'first' || value.sourceRowId === 'second')
  assert.deepEqual(users.map(value => value.displayTurn), [21, 22])
  assert.ok(users.every(value => value.sourceStepId === undefined && value.displayStep === undefined))
})

test('the real observed history facade exposes step anchors before resource enrichment finishes', async () => {
  let prepared = false
  let readPreparedContent = false
  let finishPreparation!: () => void
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve })
  const owner = {
    logicalSessionId: SessionId('observed-history-facade-fixture'), historyPageId: 0,
    options: { model: 'fixture' }, bound: { flavor: 'claude' },
    content: { async prepare() { await preparation; prepared = true }, get() { if (prepared) readPreparedContent = true; return undefined } },
  } as unknown as HapiObservedAgent
  const resource = row('resource-row', 4, {}, { content: { role: 'agent', content: { type: 'output', data: {
    type: 'assistant', uuid: 'resource-message', message: { content: [
      { type: 'image', source: { type: 'base64', data: 'aW1hZ2U=', media_type: 'image/png' } },
    ] },
  } } } })
  const page = await HapiObservedAgent.prototype.renderHistoryPage.call(owner, [call(), result(), resource])
  assert.equal(prepared, false, 'the readable page must not wait for resource import')
  assert.ok(page.resourceEnrichment)
  assert.ok(page.stepAnchors?.size)
  const toolStep = annotations(page.events).find(item => item.sourceRowId === 'call-row')?.sourceStepId
  assert.ok(toolStep)
  for (const item of annotations(page.events)) {
    assert.ok(item.sourceStepId)
    const anchor = page.stepAnchors?.get(item.sourceStepId)
    assert.equal(anchor?.turn, item.displayTurn); assert.equal(anchor?.step, item.displayStep)
  }
  finishPreparation()
  const enriched = await page.resourceEnrichment
  assert.equal(prepared, true)
  assert.equal(readPreparedContent, true)
  assert.deepEqual(enriched.stepAnchors?.get(toolStep), page.stepAnchors?.get(toolStep))
})

test('an observed context beginning inside a turn aligns with its live seed without directory I/O', async () => {
  const rows = [user('first', 1), row('first-answer', 2, { type: 'message', message: 'First answer.' }),
    user('second', 3), row('second-answer', 4, { type: 'message', message: 'Second answer.' })]
  const seed = render(rows.slice(2), 100)
  let reads = 0
  const agent = {
    id: SessionId('hapi-observed-data-owned-fixture'), binding: { hapiSessionId: 'source' },
    historyWindowAnchor: () => ({ epoch: 1, before: { at: 1003, seq: 3 }, firstTurn: 101, hasOlder: true,
      oldest: { id: 'second', at: 1003, seq: 3 } }),
    historyTurnAnchors: () => seed.projector.turnAnchorEntries(),
    renderHistoryPage: async (page: readonly HapiMessage[]): Promise<RenderedHistoryPage> => {
      const value = render(page)
      return { events: value.events(), eventSources: value.projector.eventSources()!, lastTurn: value.projector.lastTurn,
        sources: value.projector.sourceSeqEntries(), rewinds: value.projector.rewindSeqEntries(), forks: new Map(),
        turnAnchors: value.projector.turnAnchorEntries(), stepAnchors: value.projector.stepAnchorEntries() }
    },
  }
  const window = new SourceHistoryWindow(agent, {} as HapiTransport, undefined, async () => {
    reads++
    throw new Error('metadata unavailable')
  })
  try {
    const store = new SourceWindowStore()
    store.apply({ kind: 'replace', frames: toSourceFrames({ events: seed.events(), eventSources: seed.projector.eventSources()!,
      turnAnchors: seed.projector.turnAnchorEntries(), stepAnchors: seed.projector.stepAnchorEntries() }) })
    const initial = annotations(store.entries.flatMap(entry => entry.type === 'event' ? [entry.event] : []))
    const secondTurn = initial.find(item => item.sourceRowId === 'second')!.displayTurn!
    const page = await window.windowAt('second', 2, 3_000_000_000, async () => ({ messages: rows.slice(1),
      page: { epoch: 1, reset: false, beforeCursor: { at: 1002, seq: 2 }, afterCursor: { at: 1004, seq: 4 },
        hasMoreBefore: true, hasMoreAfter: false } }))
    store.apply({ kind: 'merge', frames: page.frames })
    const rendered = annotations(store.entries.flatMap(entry => entry.type === 'event' ? [entry.event] : []))
    const firstTurn = rendered.find(item => item.sourceRowId === 'first-answer')!.displayTurn!
    assert.ok(firstTurn < secondTurn, 'the preceding partial turn stays before the existing live turn')
    assert.deepEqual(rendered.map(item => [item.sourceRowId, item.displayTurn]),
      [['first-answer', firstTurn], ['second', secondTurn], ['second-answer', secondTurn]])
    assert.equal(reads, 0, 'source identities align the page with the live turn without a directory request')
  } finally { window.dispose() }
})
