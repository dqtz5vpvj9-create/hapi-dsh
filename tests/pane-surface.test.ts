import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    PANE_GRAPH_EXCLUDE, PANE_GRAPH_POLICY, filterPluginEventBody, filterPluginEventData, paneRows,
} from '../src/client/surface/pane-graph.ts'

const graph = {
    rev: 'rev-1',
    entries: [
        { id: '@deepseek-ai/dsh-client-ui-layout', url: 'layout.js', rev: 'a', inject: [] },
        { id: 'hapi-dsh', url: 'hapi.js', rev: 'b' },
        { id: '@deepseek-ai/dsh-client-ui-settings-account', url: 'account.js', rev: 'c' },
        { id: '@deepseek-ai/dsh-client-ui-settings-shell', url: 'shell.js', rev: 'd' },
        { id: '@deepseek-ai/dsh-client-ui-conversation', url: 'conversation.js', rev: 'e', inject: [] },
        { id: '@deepseek-ai/dsh-client-ui-deliverables', url: 'deliverables.js', rev: 'f' },
    ],
    batches: [
        { phase: 'bootstrap' as const, url: 'combo-1.js', rev: 'x', entries: ['@deepseek-ai/dsh-client-ui-layout', 'hapi-dsh'] },
        { phase: 'application' as const, url: 'combo-2.js', rev: 'y', entries: ['@deepseek-ai/dsh-client-ui-settings-account', '@deepseek-ai/dsh-client-ui-settings-shell', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-deliverables'] },
    ],
}

const RETAINED = ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-deliverables']

test('pane graph drops chrome rows and hapi-dsh but keeps the conversation closure', () => {
    assert.deepEqual(paneRows(graph), RETAINED)
    assert.equal(PANE_GRAPH_EXCLUDE.has('hapi-dsh'), true)
})

test('pane graph retains ui-deliverables: present tool renderer and changes-review rightbar tab', () => {
    // Pinned client.js:2299-2310 registers tool.call.toolview "present" and the
    // changes-review sidebar.right.pane.tab; both are conversation/right-column
    // surfaces, not window chrome.
    assert.equal(PANE_GRAPH_EXCLUDE.has('@deepseek-ai/dsh-client-ui-deliverables'), false)
    assert.ok(paneRows(graph).includes('@deepseek-ai/dsh-client-ui-deliverables'))
})

test('pane graph gives every retained row its own single-resource batch with the original phase', () => {
    const projected = PANE_GRAPH_POLICY.transform(graph)
    assert.deepEqual(projected.batches.map(batch => batch.phase), ['bootstrap', 'application', 'application'])
    assert.deepEqual(projected.batches.map(batch => batch.entries), [['@deepseek-ai/dsh-client-ui-layout'], ['@deepseek-ai/dsh-client-ui-conversation'], ['@deepseek-ai/dsh-client-ui-deliverables']])
    assert.deepEqual(projected.entries.map(row => row.url), ['layout.js', 'conversation.js', 'deliverables.js'])
})

test('pane graph projection rewrites HMR graph syncs onto the same subset', () => {
    const data = filterPluginEventData(JSON.stringify({ type: 'graph', graph }))
    assert.ok(data)
    const frame = JSON.parse(data) as { type: string; graph: { entries: Array<{ id: string }>; batches: Array<{ entries: string[] }> } }
    assert.deepEqual(frame.graph.entries.map(row => row.id), RETAINED)
    assert.deepEqual(frame.graph.batches.map(batch => batch.entries), [['@deepseek-ai/dsh-client-ui-layout'], ['@deepseek-ai/dsh-client-ui-conversation'], ['@deepseek-ai/dsh-client-ui-deliverables']])
})

test('pane graph projection drops rebuilds of excluded rows only', () => {
    assert.equal(filterPluginEventData(JSON.stringify({ type: 'rebuilt', id: 'hapi-dsh', rev: 'new' })), undefined)
    assert.equal(filterPluginEventData(JSON.stringify({ type: 'rebuilt', id: '@deepseek-ai/dsh-client-ui-settings-account', rev: 'new' })), undefined)
    const kept = JSON.stringify({ type: 'rebuilt', id: '@deepseek-ai/dsh-client-ui-deliverables', rev: 'new' })
    assert.equal(filterPluginEventData(kept), kept)
})

test('pane graph projection leaves foreign and malformed frames untouched', () => {
    const other = JSON.stringify({ type: 'announce', payload: 1 })
    assert.equal(filterPluginEventData(other), other)
    assert.equal(filterPluginEventData('not json'), 'not json')
    assert.equal(filterPluginEventData(JSON.stringify({ type: 'graph', graph: { entries: 'no' } })), JSON.stringify({ type: 'graph', graph: { entries: 'no' } }))
})

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function sseFrame(value: unknown): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
}

function streamOf(parts: readonly Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) { for (const part of parts) controller.enqueue(part); controller.close() },
    })
}

/** Manually driven official-event source: push, then close, like the SSE wire. */
function manualStream(): { stream: ReadableStream<Uint8Array>; push(part: Uint8Array): void; close(): void; cancelled(): boolean } {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
        start(next) { controller = next },
        cancel() { cancelled = true },
    })
    return {
        stream,
        push(part) { controller!.enqueue(part) },
        close() { controller!.close() },
        cancelled: () => cancelled,
    }
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string> {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
    }
    const merged = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
    return decoder.decode(merged)
}

test('SSE projection reassembles frames split across arbitrary byte chunks, including multi-byte UTF-8', async () => {
    const graphFrame = { type: 'graph', graph, note: '帧-数据' }
    const excludedRebuild = sseFrame({ type: 'rebuilt', id: '@deepseek-ai/dsh-client-ui-settings-account', rev: 'r2' })
    const unrelated = sseFrame({ type: 'announce', payload: 'ok' })
    const wire = encoder.encode(`data: ${JSON.stringify(graphFrame)}\n\n`)
    const expectedGraph = `data: ${JSON.stringify({ ...graphFrame, graph: PANE_GRAPH_POLICY.transform(graph) })}\n\n`

    // Split every 3 bytes: guaranteed mid-frame and mid-UTF-8 boundaries.
    const bytes = new Uint8Array(wire.byteLength + excludedRebuild.byteLength + unrelated.byteLength)
    bytes.set(wire, 0); bytes.set(excludedRebuild, wire.byteLength); bytes.set(unrelated, wire.byteLength + excludedRebuild.byteLength)
    const parts: Uint8Array[] = []
    for (let offset = 0; offset < bytes.byteLength; offset += 3) parts.push(bytes.slice(offset, offset + 3))

    const output = await collect(filterPluginEventBody(streamOf(parts)))
    assert.equal(output, expectedGraph + decoder.decode(unrelated))
})

test('SSE projection keeps per-stream decode state: interleaved pane streams never corrupt each other', async () => {
    const graphFrameA = { type: 'graph', graph, note: '帧甲' }
    const graphFrameB = { type: 'graph', graph, note: '帧乙' }
    const textA = `data: ${JSON.stringify(graphFrameA)}\n\n`
    const wireA = encoder.encode(textA)
    const wireB = encoder.encode(`data: ${JSON.stringify(graphFrameB)}\n\n`)
    // Split A one byte into the multi-byte note character: the first chunk leaves
    // the decoder holding a partial code point.
    const split = encoder.encode(textA.slice(0, textA.indexOf('帧'))).byteLength + 1

    const sourceA = manualStream()
    const filteredA = filterPluginEventBody(sourceA.stream)
    const readerA = filteredA.getReader()
    const pendingA = (async () => {
        const chunks: Uint8Array[] = []
        for (;;) {
            const { done, value } = await readerA.read()
            if (done) break
            chunks.push(value)
        }
        const merged = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0))
        let offset = 0
        for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
        return decoder.decode(merged)
    })()

    sourceA.push(wireA.slice(0, split))
    // Stream B completes while A sits between UTF-8 bytes.
    const outputB = await collect(filterPluginEventBody(streamOf([wireB])))
    sourceA.push(wireA.slice(split))
    sourceA.close()
    const outputA = await pendingA

    assert.equal(outputB, `data: ${JSON.stringify({ ...graphFrameB, graph: PANE_GRAPH_POLICY.transform(graph) })}\n\n`)
    assert.equal(outputA, `data: ${JSON.stringify({ ...graphFrameA, graph: PANE_GRAPH_POLICY.transform(graph) })}\n\n`)
})

test('SSE projection cancellation cancels the official event source', async () => {
    const source = manualStream()
    const filtered = filterPluginEventBody(source.stream)
    const reader = filtered.getReader()
    source.push(sseFrame({ type: 'announce', payload: 1 }))
    const first = await reader.read()
    assert.equal(first.done, false)
    await reader.cancel(new Error('pane closed'))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(source.cancelled(), true)
})
