/** Independent GC process using synthetic text; no application state or source connections. */
import assert from 'node:assert/strict'
import { ObservedScopeIndex } from '../../src/hapi-agent/scopes.js'
import { sourceScopeRow } from './source-scope-row.js'

const mode = process.argv[2], snapshots = Number(process.argv[3]), width = 512
assert.ok(mode === 'raw-control' || mode === 'agent-run' || mode === 'sdk')
assert.ok(Number.isSafeInteger(snapshots) && snapshots > 0)
assert.ok(global.gc, 'Run with --expose-gc')
function retainedHeap(): number { global.gc!(); global.gc!(); return process.memoryUsage().heapUsed }
function warm(): void {
  const index = new ObservedScopeIndex()
  for (let count = 1; count <= 8; count++) index.update([sourceScopeRow(count, width, mode === 'sdk' ? 'sdk' : 'agent-run')])
}
warm()
const baseline = retainedHeap(), index = new ObservedScopeIndex(), raw = new Map<string, unknown>()
function append(count: number): void {
  const row = sourceScopeRow(count, width, mode === 'sdk' ? 'sdk' : 'agent-run')
  index.update([row])
  // Negative control models the original Fact.data ownership, independently
  // retaining every cumulative body under its fresh transport row ID.
  if (mode === 'raw-control') raw.set(row.id, row.content)
}
for (let count = 1; count <= snapshots; count++) append(count)
const growthBytes = retainedHeap() - baseline
assert.equal(index.scopes().length, 1)
assert.equal(index.forRow(sourceScopeRow(1, 1, mode === 'sdk' ? 'sdk' : 'agent-run')).scopeId,
  mode === 'sdk' ? 'sdk-tool:task-child' : 'run:child')
if (mode === 'raw-control') assert.equal(raw.size, snapshots)
console.log(JSON.stringify({ mode, snapshots, finalTextBytes: snapshots * width,
  cumulativeTextBytes: snapshots * (snapshots + 1) / 2 * width, growthBytes }))
