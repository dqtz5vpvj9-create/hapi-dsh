import assert from 'node:assert/strict'
import { test } from 'node:test'
import { machineHealthPresentation, machineUptime } from '../src/client/machine-health.ts'
import { catalogSourceMachine, sourceMachineHealth } from '../src/hapi/source-machines.ts'

test('machine health preserves source identity and reports offline without substituting host metrics', () => {
    const row = catalogSourceMachine({ id: 'remote-beta', active: true, activeAt: 100,
        metadata: { host: 'remote', displayName: 'Beta', platform: 'linux', happyCliVersion: 'fixture-version', secret: 'do-not-export' },
        health: { collectedAt: 99, cpuCount: 8, cpuPercent: 72, memoryPercent: 91, load1m: 2.4, uptimeSeconds: 6540, secret: 'do-not-export' },
    }, false)
    assert.equal(row.online, false); assert.equal(row.id, 'remote-beta'); assert.equal(row.version, 'fixture-version')
    assert.ok(!JSON.stringify(row).includes('do-not-export'))
    const presentation = machineHealthPresentation(row.health, row.platform)!
    assert.equal(presentation.tone, 'critical'); assert.equal(presentation.load, '2.4/8'); assert.equal(presentation.uptime, '1h 49m')
    assert.deepEqual(presentation.metrics.map(value => value.percent), [72, 91])
})

test('unknown metrics remain unknown and Windows never displays the source load average as Unix load', () => {
    assert.equal(machineHealthPresentation(null), null)
    const windows = machineHealthPresentation({ collectedAt: 100, load1m: 99, uptimeSeconds: 60 }, 'win32')!
    assert.equal(windows.tone, 'unknown'); assert.equal(windows.load, null); assert.deepEqual(windows.metrics, [])
    assert.equal(windows.uptime, '1m')
    assert.equal(machineHealthPresentation({ collectedAt: 100, cpuPercent: 0 }, 'linux')!.metrics[0]?.percent, 0)
    assert.equal(machineHealthPresentation({ collectedAt: 100, load1m: 12, cpuCount: 8 }, 'linux')!.tone, 'critical')
})

test('malformed health samples cannot crash the sidebar or turn absent values into zero', () => {
    for (const value of [undefined, null, { collectedAt: 10, cpuPercent: 101 }, { collectedAt: Infinity }, { collectedAt: 1e30 }, { collectedAt: 10, memoryPercent: -1 }]) {
        assert.equal(sourceMachineHealth(value), null)
    }
    assert.equal(machineUptime(-1), null); assert.equal(machineUptime(NaN), null); assert.equal(machineUptime(90000), '1d 1h')
})
