import assert from 'node:assert/strict'
import test from 'node:test'
import { HostOpeningTiming, PaneOpeningTiming } from '../src/client/surface/pane-opening.ts'
import { DiagnosticsCore, type DiagnosticInput } from '../src/client/diagnostics/state.ts'

test('host timing includes resources and graph startup before any session reference exists', () => {
    let now = 20
    const entries: DiagnosticInput[] = []
    const timing = new HostOpeningTiming('remote-host', entry => entries.push(entry), () => now)
    now = 70; timing.mark('resources')
    now = 170; timing.mark('graph')
    now = 220; timing.mark('ui'); timing.mark('ui')
    now = 230; timing.mark('catalog')
    assert.deepEqual(entries.map(entry => [entry.method, entry.durationMs]), [
        ['host.resources', 50], ['host.graph', 150], ['host.ui', 200], ['host.catalog', 210],
    ])
    assert.ok(entries.every(entry => entry.identity?.hostId === 'remote-host' && entry.requestId === entries[0]!.requestId))
})

test('pane timings keep content and composer separate and ignore later stream updates', () => {
    let now = 100
    const entries: DiagnosticInput[] = []
    const timing = new PaneOpeningTiming({ hostId: 'host', sessionId: 'session' }, true, entry => entries.push(entry), () => now)
    now = 140; timing.referenceReady(false)
    now = 180; timing.mark('content')
    assert.equal(timing.complete, false)
    now = 220; timing.mark('composer')
    assert.equal(timing.complete, true)
    timing.stop()
    now = 999; timing.mark('content'); timing.stop('error')
    assert.deepEqual(entries.map(entry => [entry.method, entry.durationMs, entry.outcome]), [
        ['pane.reference.ready', 40, 'warm'], ['pane.content.mounted', 80, 'warm'], ['pane.composer.mounted', 120, 'warm'],
    ])
})

test('early composer mounts and empty sessions do not masquerade as loaded history', () => {
    const entries: DiagnosticInput[] = []
    const timing = new PaneOpeningTiming({ sessionId: 'empty' }, false, entry => entries.push(entry), () => 0)
    timing.mark('composer')
    assert.equal(timing.complete, false)
    timing.referenceReady(true)
    assert.equal(timing.complete, true)
    timing.stop()
    assert.deepEqual(entries.map(entry => entry.method), ['pane.composer.mounted', 'pane.reference.ready'])
    assert.ok(entries.every(entry => entry.outcome === 'cold'))
})

test('aborted or timed out panes produce one incomplete record without leaking into other panes', () => {
    const core = new DiagnosticsCore()
    const left = new PaneOpeningTiming({ hostId: 'left', sessionId: 'same' }, true, entry => core.add(entry), () => 100)
    const right = new PaneOpeningTiming({ hostId: 'right', sessionId: 'same' }, false, entry => core.add(entry), () => 200)
    left.stop('hidden'); left.referenceReady(false); left.stop('closed')
    right.referenceReady(false); right.mark('content'); right.stop('timeout'); right.mark('composer')
    const entries = core.getSnapshot().entries
    assert.equal(entries.length, 4)
    assert.equal(entries[0]!.outcome, 'hidden')
    assert.equal(entries[0]!.identity!.hostId, 'left')
    assert.equal(entries.at(-1)!.outcome, 'timeout')
    assert.equal(entries.at(-1)!.identity!.hostId, 'right')
    assert.notEqual(entries[0]!.requestId, entries[1]!.requestId)
    assert.equal(entries[1]!.requestId, entries.at(-1)!.requestId)
    assert.match(core.format(), /pane.incomplete/)
    assert.match(core.format(), /durationMs=0/)
})
