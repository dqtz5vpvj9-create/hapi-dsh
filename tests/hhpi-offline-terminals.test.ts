/** Actual offline terminal converter with synthetic copies of current legacy schemas. No PTY exists in these tests. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTerminalsStage } from '../scripts/migrations/hapi-offline/terminals.ts'
import { runOfflineMigration } from '../scripts/migrations/hapi-offline/index.ts'
import { offlineDomainFixture } from './helpers/hhpi-offline-domain-fixture.ts'
const source = { sourceHubId: 'hub-a', sourceSessionId: 'hapi-a', machineId: 'machine-a' }
const terminal = { terminalId: 'recorded-terminal', title: 'same shell', cwd: '/same', pid: 42, createdAt: 10, endedAt: null, status: 'running', exitCode: null, cols: 80, rows: 24, seq: 8, controllerId: 'old-controller', controlVersion: 3 }
const proof = { source, terminalId: terminal.terminalId, ownerId: 'old-owner', pid: 42, processBirthId: 'pid-42-birth-a', state: 'exited', observedAt: 30, exitCode: 0 }

test('close confirmed and bounded output are retained but do not prove process exit or create a replacement shell', async t => {
    const stage = createTerminalsStage([{ inputId: 'closed', kind: 'closed-registry' }, { inputId: 'list', kind: 'machine-inventory', source }, { inputId: 'output', kind: 'machine-replay', source }])
    const f = await offlineDomainFixture(t, { closed: { version: 1, terminals: { 'recorded-terminal': 'confirmed' } }, list: [terminal], output: { terminal, reset: true, data: '\u001b[31m原始滚屏\r\n', seq: 8 } }, stage)
    assert.equal(f.index.status, 'needs-review')
    const replay = f.objects.find(row => row.inputId === 'output')!
    assert.deepEqual((replay.body.value.original as { data: string }).data, '\u001b[31m原始滚屏\r\n')
    assert.equal((replay.body.value.converted as { reuse: string }).reuse, 'none')
    assert.ok(f.objects.find(row => row.id === '["report","terminals"]')!.body.value.blockers!.length)
    assert.deepEqual(await runOfflineMigration(f.request, f.output, [stage]), f.index)
    await assert.rejects(runOfflineMigration(f.request, f.output, [createTerminalsStage([{ inputId: 'list', kind: 'machine-inventory', source: { ...source, machineId: 'different-machine' } }])]), /selection or exact mapping changed/)
    for (const input of f.index.inputs) assert.deepEqual(await readFile(join(f.output, input.file)), await readFile(join(f.snapshot, input.originalPath)))
})

test('exact exited process evidence closes only its own terminal and remains offline evidence', async t => {
    const f = await offlineDomainFixture(t, { list: [terminal], evidence: { version: 1, records: [proof] } }, createTerminalsStage([{ inputId: 'list', kind: 'machine-inventory', source }, { inputId: 'evidence', kind: 'process-evidence' }]))
    const item = f.objects.find(row => row.inputId === 'list')!
    assert.equal(item.state, 'preserved'); assert.equal((item.body.value.converted as { exitEvidenceSatisfied: boolean }).exitEvidenceSatisfied, true)
    assert.equal(f.index.status, 'complete')
    assert.equal((f.objects.find(row => row.id === '["report","terminals"]')!.body.value as { productionCutoverPerformed?: boolean }).productionCutoverPerformed, false)
})

test('PID reuse, wrong machine, conflicting owners and tied contradictory evidence remain unresolved', async t => {
    for (const records of [[{ ...proof, pid: 99 }], [{ ...proof, source: { ...source, machineId: 'other-machine' } }], [proof, { ...proof, processBirthId: 'new-pid-birth' }], [proof, { ...proof, state: 'running' }]]) {
        const f = await offlineDomainFixture(t, { list: [terminal], evidence: { version: 1, records } }, createTerminalsStage([{ inputId: 'list', kind: 'machine-inventory', source }, { inputId: 'evidence', kind: 'process-evidence' }]))
        assert.equal(f.index.status, 'needs-review')
        assert.equal(f.objects.find(row => row.inputId === 'list')!.state, 'unresolved')
    }
})

test('unsupported schemas and text-only capture preserve originals while keeping the owner gate open', async t => {
    const text = { id: 'hapi-legacy-recorded', sessionId: 'display-recorded', terminalId: 'recorded-terminal', source, provenance: 'adapter-observed', replay: 'bounded-source-tail', replayIssue: 'history-truncated', sequence: 12, capturedAt: 30, lines: ['earlier retained output', '中文'], localLimitReached: true }
    const f = await offlineDomainFixture(t, { text, closed: { version: 2, terminals: { t: 'unknown-state' } } }, createTerminalsStage([{ inputId: 'text', kind: 'legacy-text' }, { inputId: 'closed', kind: 'closed-registry' }]))
    assert.equal(f.index.status, 'needs-review')
    assert.deepEqual(f.objects.find(row => row.inputId === 'text')!.body.value.original, text)
    assert.equal(f.objects.find(row => row.inputId === 'closed')!.body.value.disposition, 'offline-recovery')
    assert.match(f.objects.find(row => row.id === '["report","terminals"]')!.body.value.blockers!.join(' '), /No actual terminal\/process inventory/)
})
