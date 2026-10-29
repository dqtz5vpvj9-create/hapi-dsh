import assert from 'node:assert/strict'
import test from 'node:test'
import { historyScrollBelongsToReader, historyWindowProgressed, historyWindowWasReset, probeHistoryWindow } from '../src/client/seamless/controller.ts'

function windowOf(keys: string[]): HTMLElement {
    return { querySelectorAll: () => keys.map(key => ({
        getAttribute: () => key, closest: () => null,
        getBoundingClientRect: () => { throw new Error('Window identity must not request layout') },
    })) } as unknown as HTMLElement
}

test('bounded prepends remain progress when the opposite tail is evicted', () => {
    const before = probeHistoryWindow(windowOf(['old-head', 'middle', 'tail']))
    for (const keys of [['older', 'old-head', 'middle'], ['older', 'old-head']]) {
        const after = probeHistoryWindow(windowOf(keys), before.firstKey)
        assert.equal(historyWindowProgressed(before, after), true)
        assert.equal(historyWindowWasReset(before, after), false)
    }
})

test('a replacement head without the requested head cannot commit an earlier page', () => {
    const before = probeHistoryWindow(windowOf(['old-head', 'middle', 'tail']))
    for (const keys of [['replacement'], ['replacement', 'b', 'c'], ['replacement', 'b', 'c', 'd']]) {
        const after = probeHistoryWindow(windowOf(keys), before.firstKey)
        assert.equal(historyWindowProgressed(before, after), false)
        assert.equal(after.retainedHeadIndex, -1)
        assert.equal(historyWindowWasReset(before, after), keys.length < before.count)
    }
})

test('live appends and transient tail contractions cannot manufacture older progress', () => {
    const before = probeHistoryWindow(windowOf(['old-head', 'middle', 'tail']))
    for (const keys of [['old-head', 'middle'], ['old-head', 'middle', 'tail', 'live']]) {
        const after = probeHistoryWindow(windowOf(keys), before.firstKey)
        assert.equal(historyWindowProgressed(before, after), false)
        assert.equal(historyWindowWasReset(before, after), false)
    }
})

test('the first nonempty source page can commit an initially empty window', () => {
    const before = probeHistoryWindow(windowOf([]))
    assert.equal(historyWindowProgressed(before, probeHistoryWindow(windowOf(['first']), before.firstKey)), true)
    assert.equal(historyWindowProgressed(before, probeHistoryWindow(windowOf([]), before.firstKey)), false)
})

test('prepend compensation cannot reverse a fresh upward gesture into forward paging', () => {
    assert.equal(historyScrollBelongsToReader('up', 'up', 100, false), true)
    assert.equal(historyScrollBelongsToReader('down', 'up', 100, false), false)
    assert.equal(historyScrollBelongsToReader('up', 'down', 100, false), false)
    assert.equal(historyScrollBelongsToReader('none', 'up', 100, false), false)
})

test('expired gesture motion does not page again, while an actual scrollbar drag can', () => {
    assert.equal(historyScrollBelongsToReader('up', 'up', 251, false), false)
    assert.equal(historyScrollBelongsToReader('down', 'none', Infinity, false), false)
    assert.equal(historyScrollBelongsToReader('down', 'up', 1000, true), true)
    assert.equal(historyScrollBelongsToReader('none', 'up', 1000, true), false)
})

test('a folded process commits real earlier cursor progress while retaining the same outer DOM', () => {
    const dom = probeHistoryWindow(windowOf(['folded-process', 'answer']))
    const source = { before: { at: 10, seq: 200 }, historyId: 'same-source', historyVersion: 0 }
    const before = { ...dom, source }
    const after = { ...dom, retainedHeadIndex: 0, source: { ...source, before: { at: 10, seq: 180 } } }
    assert.equal(historyWindowProgressed(before, after), true)
    assert.equal(historyWindowWasReset(before, after), false)
    assert.equal(historyWindowProgressed(before, { ...after, source }), false, 'the same cursor is not a successful page')
    assert.equal(historyWindowProgressed(before, { ...after, source: { ...source, before: { at: 10, seq: 220 } } }), false,
        'live arrivals or forward trimming are not earlier progress')
    for (const changed of [{ ...after.source, historyId: 'restarted-source' }, { ...after.source, historyVersion: 1 }]) {
        assert.equal(historyWindowProgressed(before, { ...after, source: changed }), false)
        assert.equal(historyWindowWasReset(before, { ...after, source: changed }), true)
    }
})
