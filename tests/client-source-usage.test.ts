/** Synthetic source counters; no browser or native execution is involved. */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { NativeUsage } from '../src/codex/observation-types.ts'
import type { ObservedUsage } from '../src/hapi-agent/projection-types.ts'
import { parseObservedMessage } from '../src/hapi-agent/parser.ts'
import { formatSourceTokens, sourceUsageModel } from '../src/client/source-usage-model.ts'

const native: NativeUsage = { id: 'usage', createdAt: 1, threadId: 'thread', turnId: 'turn', model: 'fixture',
    inputTokens: 1000, outputTokens: 80, cachedInputTokens: 750, contextTokens: 1000, contextWindow: 10000,
    total: { inputTokens: 20000, outputTokens: 2000, cachedInputTokens: 15000 } }
const observed: ObservedUsage = { id: 'usage', createdAt: 1, model: 'fixture', inputTokens: 100, outputTokens: 50,
    cachedInputTokens: 800, cacheCreationTokens: 100, inputIncludesCache: false, contextTokens: 1050, contextWindow: 10000 }

test('Codex cumulative usage includes cache exactly once and context uses the current request', () => {
    const model = sourceUsageModel(native, null)!
    assert.equal(model.scope, 'session')
    assert.equal(model.total, 22000)
    assert.equal(model.cacheHit, 75)
    assert.equal(model.contextTokens, 1000)
    assert.equal(model.contextPercent, 10)
})

test('Codex without cumulative counters labels only the latest report and omits missing cache/window', () => {
    const model = sourceUsageModel({ ...native, total: null, cachedInputTokens: null, contextWindow: null }, null)!
    assert.equal(model.scope, 'reported')
    assert.equal(model.total, 1080)
    assert.equal(model.cacheHit, null)
    assert.equal(model.contextPercent, null)
})

test('Claude cache read/write are disjoint from input and output never enters the cache denominator', () => {
    const model = sourceUsageModel(null, observed)!
    assert.equal(model.total, 1050)
    assert.equal(model.cacheHit, 80)
    assert.equal(model.scope, 'reported', 'a result summary is not silently called whole-session usage')
})

test('observed accounting comes from the wire shape, including non-native Codex records', () => {
    const parse = (type: string, data: Record<string, unknown>) => {
        const item = parseObservedMessage({ id: 'usage-row', seq: 1, localId: null, createdAt: 1,
            content: { role: 'agent', content: { type, data } } }).find(item => item.kind === 'usage')
        assert.ok(item?.kind === 'usage')
        return item.usage
    }
    const codex = parse('codex', { type: 'token_count', info: { last: { inputTokens: 1000, outputTokens: 50, cachedInputTokens: 800 } } })
    assert.equal(codex.inputIncludesCache, true)
    assert.equal(sourceUsageModel(null, codex)?.total, 1050)
    assert.equal(sourceUsageModel(null, codex)?.cacheHit, 80)
    const claude = parse('output', { type: 'assistant', message: { content: [], usage: {
        input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 100,
    } } })
    assert.equal(claude.inputIncludesCache, false)
    assert.equal(sourceUsageModel(null, claude)?.total, 1050)
    assert.equal(sourceUsageModel(null, claude)?.cacheHit, 80)
})

test('older observed snapshots retain raw values without guessing an accounting convention', () => {
    const { inputIncludesCache: _old, ...old } = observed
    const model = sourceUsageModel(null, old)!
    assert.equal(model.input, 100)
    assert.equal(model.output, 50)
    assert.equal(model.total, null)
    assert.equal(model.cacheHit, null)
})

test('unreported usage stays absent, while an explicit zero report does not produce NaN or infinity', () => {
    assert.equal(sourceUsageModel(null, undefined), null)
    const model = sourceUsageModel({ ...native, total: null, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, contextTokens: 0 }, null)!
    assert.equal(model.total, 0)
    assert.equal(model.cacheHit, null)
    assert.equal(model.contextPercent, 0)
})

test('independent source reports never sum across panes or add a Codex total to its last request', () => {
    assert.equal(sourceUsageModel(native, observed)?.total, 22000)
    assert.equal(sourceUsageModel(null, observed)?.total, 1050)
    assert.equal(sourceUsageModel(native, null)?.total, 22000)
})

test('compact token readings retain small counts and use decimal K/M/B units', () => {
    assert.deepEqual([0, 98, 1234, 390000000, 2400000000].map(formatSourceTokens), ['0', '98', '1.2K', '390M', '2.4B'])
})
