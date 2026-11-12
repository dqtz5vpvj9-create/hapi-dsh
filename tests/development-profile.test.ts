import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { openStore, policyRecord } from '../scripts/development/store.mjs'
import { startRun, startSpan, finishSpan, profileReport, transitionTask, assignTask, readyTasks, observe, finishRun, taskContext, recordGate, recordProgress } from '../scripts/development/profile.mjs'
import { runCommand } from '../scripts/development/runner.mjs'
import { runHarness } from '../scripts/development/harness.mjs'
import { importCodex } from '../scripts/development/codex-import.mjs'
import { writeReport } from '../scripts/development/report.mjs'
import { dashboardSnapshot, writeDashboard } from '../scripts/development/dashboard.mjs'
import { JSDOM } from 'jsdom'
import { proposePolicy, evaluatePolicy, promotePolicy, rollbackPolicy, compareResults } from '../scripts/development/rsi.mjs'
import { main as profileCli } from '../scripts/development/cli.mjs'

function fixture(t) {
  const directory = mkdtempSync('/mnt/cache/data-cache/hhpi-profile-test-')
  const store = openStore(join(directory, 'profile.sqlite'))
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, store }
}

test('cancelled RSI CLI rejects before reading a suite or starting workers', async () => {
  await assert.rejects(profileCli(['rsi', 'evaluate', '--candidate', 'unused', '--suite', '/not-read/suite.json']), /cancelled by the user/)
})

test('named checks reuse only matching inputs and stop unchanged failures without blocking other work', async t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'reuse', root: directory })
  const options = { run: 'reuse', kind: 'product-test', label: 'first label', check: 'upload', inputs: 'change-1-node24', stdio: 'ignore' }
  const command = [process.execPath, '-e', 'process.exit(0)']
  const first = await runCommand(store, { ...options, command })
  const reused = await runCommand(store, { ...options, label: 'another label', command })
  assert.equal(reused.executed, false)
  assert.equal(reused.reused, first.span)
  assert.equal(profileReport(store, 'reuse').spans.length, 1)
  assert.equal((await runCommand(store, { ...options, inputs: 'change-2-node24', command })).executed, true)
  const failure = { ...options, check: 'failure', command: [process.execPath, '-e', 'process.exit(7)'] }
  await runCommand(store, failure)
  await runCommand(store, failure)
  await assert.rejects(runCommand(store, failure), /Two unchanged failures/)
  assert.equal((await runCommand(store, { ...failure, reason: 'Probe whether the configured executable exits before loading the fixture' })).exitCode, 7)
  assert.equal((await runCommand(store, { run: 'reuse', label: 'local diagnosis', command, stdio: 'ignore' })).executed, true)
})

test('parallel callers do not launch a second named check while its owner is running', async t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'parallel', root: directory })
  const options = { run: 'parallel', label: 'slow fixture', kind: 'product-test', check: 'same-check', inputs: 'change-1',
    command: [process.execPath, '-e', 'setTimeout(()=>{},40)'], stdio: 'ignore' }
  const first = runCommand(store, options)
  const joined = runCommand(store, { ...options, agent: 'another-agent' })
  const completed = await first
  assert.equal(completed.exitCode, 0)
  assert.equal((await joined).joined, completed.span)
  assert.equal((await joined).executed, false)
  assert.equal(profileReport(store, 'parallel').spans.length, 1)
})

test('shared checks deliver the same failure and do not reuse another command or environment', async t => {
  const {store, directory} = fixture(t)
  startRun(store, {id:'join-failure',root:directory})
  const options = {run:'join-failure',kind:'typecheck',check:'types',inputs:'same-source',stdio:'ignore',cwd:directory}
  const failure = [process.execPath,'-e','setTimeout(()=>process.exit(7),40)']
  const [first, second] = await Promise.all([runCommand(store,{...options,command:failure}),runCommand(store,{...options,command:failure})])
  assert.equal(first.exitCode,7);assert.equal(second.exitCode,7);assert.equal(second.joined,first.span)
  const command = [process.execPath,'-e','process.exit(0)']
  assert.equal((await runCommand(store,{...options,command})).executed,true)
  assert.equal((await runCommand(store,{...options,command,env:{HARNESS_FIXTURE:'changed'}})).executed,true)
  assert.equal((await runCommand(store,{...options,command,env:{HARNESS_FIXTURE:'changed'}})).executed,false)
})

test('nested command profiles inherit the actual agent and keep test purpose explicit', async t => {
  const {store,directory} = fixture(t)
  startRun(store,{id:'owner',root:directory})
  const module = new URL('../scripts/development/test-profile.mjs',import.meta.url).href
  const result = await runCommand(store,{run:'owner',agent:'child-worker',kind:'product-test',stdio:'ignore',
    command:[process.execPath,'--input-type=module','-e',`import{beginTestProfile,endTestProfile}from ${JSON.stringify(module)};endTestProfile(beginTestProfile('inner'),{status:'passed'})`]})
  assert.equal(result.exitCode,0)
  const spans=profileReport(store,'owner').spans
  assert.equal(spans.length,2)
  assert.ok(spans.every(s=>s.agent==='child-worker' && s.kind==='product-test'))
  assert.equal(spans.find(s=>s.label==='inner').parent,result.span)
})

test('command profiles inherit node and parent only within the same run and database while retaining the agent', async t => {
  const {store,directory} = fixture(t)
  startRun(store,{id:'scope',root:directory,dag:{nodes:[{id:'local-node'}]}})
  startRun(store,{id:'other-run',root:directory})
  const parent = startSpan(store,{run:'scope',node:'local-node',parent:null,agent:'actual-worker',label:'outer'})
  const inherited = {HHPI_PROFILE_DB:store.location,HHPI_PROFILE_RUN:'scope',HHPI_PROFILE_NODE:'local-node',HHPI_PROFILE_PARENT:parent,HHPI_PROFILE_AGENT:'actual-worker'}
  const before = Object.fromEntries(Object.keys(inherited).map(key=>[key,process.env[key]]))
  Object.assign(process.env,inherited)
  t.after(()=>{for(const [key,value] of Object.entries(before)) value===undefined ? delete process.env[key] : process.env[key]=value})
  const options = {label:'command',command:[process.execPath,'-e','process.exit(0)'],stdio:'ignore'}
  const same = await runCommand(store,{...options,run:'scope'})
  const otherRun = await runCommand(store,{...options,run:'other-run'})
  const explicit = await runCommand(store,{...options,run:'other-run',node:'work',parent:null,agent:'explicit-worker'})
  const spans = profileReport(store,'scope').spans
  assert.deepEqual([spans.find(s=>s.id===same.span).node,spans.find(s=>s.id===same.span).parent,spans.find(s=>s.id===same.span).agent],['local-node',parent,'actual-worker'])
  const other = profileReport(store,'other-run').spans
  assert.deepEqual([other.find(s=>s.id===otherRun.span).node,other.find(s=>s.id===otherRun.span).parent,other.find(s=>s.id===otherRun.span).agent],[null,null,'actual-worker'])
  assert.deepEqual([other.find(s=>s.id===explicit.span).node,other.find(s=>s.id===explicit.span).parent,other.find(s=>s.id===explicit.span).agent],['work',null,'explicit-worker'])
  const sibling = openStore(join(directory,'other.sqlite'))
  try {
    startRun(sibling,{id:'scope',root:directory})
    const result = await runCommand(sibling,{...options,run:'scope'})
    const span = profileReport(sibling,'scope').spans.find(s=>s.id===result.span)
    assert.deepEqual([span.node,span.parent,span.agent],[null,null,'actual-worker'])
  } finally { sibling.close() }
})

test('task context carries user-path delivery rules without requiring every component to close that path', t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'context', root: directory, dag: { nodes: [{ id: 'a' }, { id: 'b' }] },
    checks: [{ requirement: 'upload', layer: 'user-workflow', node: 'a' }, { requirement: 'terminal', layer: 'native', node: 'b' }] })
  const context = taskContext(store, 'context', 'a')
  assert.deepEqual(context.checks.map(c => c.requirement), ['upload'])
  assert.ok(context.instructions.some(s => s.includes('Component tasks may finish independently')))
  transitionTask(store, 'context', 'a', 'running')
  assert.equal(taskContext(store, 'context', 'a').reporting.agent, 'root')
  transitionTask(store, 'context', 'a', 'done')
  assert.equal(profileReport(store, 'context').coverage.find(c => c.requirement === 'upload').status, 'unknown')
})

test('response usage deduplicates IDs, excludes reasoning double count and survives narrower or older imports', async t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'tokens', root: directory, now: 2000 })
  const response = (id, at) => ({ type: 'token_usage_record', timestamp: new Date(at).toISOString(), payload: {
    response_id: id, usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 10 } } })
  const file = join(directory, 'usage.jsonl')
  writeFileSync(file, [
    { type: 'session_meta', payload: { id: 'tokens-session', cwd: directory } },
    response('before', 1000), response('a', 2100), response('a', 2200), response('b', 3100),
  ].map(x => JSON.stringify(x)).join('\n'))
  await importCodex(store, 'tokens', file, { until: new Date(4000).toISOString() })
  await importCodex(store, 'tokens', file, { since: new Date(3000).toISOString(), until: new Date(4000).toISOString() })
  await importCodex(store, 'tokens', file, { until: new Date(2500).toISOString() })
  const usage = profileReport(store, 'tokens').usage[0]
  assert.equal(usage.input, 200)
  assert.equal(usage.cached, 160)
  assert.equal(usage.output, 40)
})

test('profile counts overlapping work once, leaves missing browser evidence unknown, and rejects premature completion', t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'run', root: directory, now: 1000,
    checks: [{ requirement: 'upload', layer: 'browser' }, { requirement: 'upload', layer: 'component' }] })
  const first = startSpan(store, { run: 'run', node: null, parent: null, label: 'first', now: 1100 })
  const second = startSpan(store, { run: 'run', node: null, parent: null, label: 'second', now: 1150 })
  finishSpan(store, first, { status: 'passed', now: 1200 })
  finishSpan(store, second, { status: 'passed', now: 1250 })
  observe(store, 'run', { requirement: 'upload', layer: 'component', status: 'passed', evidence: 'fixture-result' })
  const report = profileReport(store, 'run', 1400)
  assert.equal(report.observedUnionMs, 150)
  assert.equal(report.inclusiveWorkMs, 200)
  assert.equal(report.coverage.find(c => c.layer === 'browser').status, 'unknown')
  assert.throws(() => finishRun(store, 'run'), /Incomplete/)
  assert.throws(() => observe(store, 'run', { requirement: 'new-path', layer: 'browser', status: 'passed', evidence: '' }), /evidence locator/)
  transitionTask(store, 'run', 'work', 'running')
  transitionTask(store, 'run', 'work', 'done')
  observe(store, 'run', { requirement: 'upload', layer: 'browser', status: 'passed', evidence: 'browser-result' })
  finishRun(store, 'run')
  observe(store, 'run', { requirement: 'upload', layer: 'browser', status: 'failed', evidence: 'user-escape', discoveredBy: 'user' })
  assert.equal(profileReport(store, 'run').observations.length, 3)
  assert.equal(profileReport(store, 'run').run.status, 'completed') // The original delivery snapshot remains visible.
  observe(store, 'run', { requirement: 'secondary-page-omission', layer: 'browser', status: 'failed', evidence: 'new-finding', discoveredBy: 'independent-review' })
  assert.equal(profileReport(store, 'run').coverage.find(c => c.requirement === 'secondary-page-omission').addedAfterStart, true)
})

test('new real-path evidence does not need an invented failure or replace an original unmet path', t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'new-paths', root: directory,
    checks: [{ requirement: 'files', layer: 'user-workflow' }] })
  transitionTask(store, 'new-paths', 'work', 'running')
  transitionTask(store, 'new-paths', 'work', 'done')
  observe(store, 'new-paths', { requirement: 'files-original-menu', layer: 'browser', status: 'passed', evidence: 'actual-menu-result.json' })
  const report = profileReport(store, 'new-paths')
  assert.equal(report.coverage.find(c => c.requirement === 'files-original-menu').status, 'passed')
  assert.equal(report.coverage.find(c => c.requirement === 'files-original-menu').addedAfterStart, true)
  assert.equal(report.coverage.find(c => c.requirement === 'files').status, 'unknown')
  assert.equal(report.observations.some(o => o.status === 'failed'), false)
  assert.throws(() => finishRun(store, 'new-paths'), /Incomplete/)
})

test('DAG claims respect dependencies, exclusive files, coordinator ownership and finish conditions', t => {
  const { store, directory } = fixture(t)
  const dag = { nodes: [
    { id: 'a', depends_on: [], write_files: ['shared.ts'] },
    { id: 'b', depends_on: [], write_files: ['shared.ts'] },
    { id: 'c', depends_on: ['a'], executor: 'coordinator', finish_gates: ['device'] },
  ] }
  startRun(store, { id: 'run', root: directory, dag })
  assert.equal(readyTasks(store, 'run').candidates[0].id, 'a')
  assert.throws(() => transitionTask(store, 'run', 'c', 'running'), /Dependencies/)
  transitionTask(store, 'run', 'a', 'running', { agent: 'child' })
  assert.throws(() => transitionTask(store, 'run', 'a', 'done'), /task owner/)
  assert.throws(() => transitionTask(store, 'run', 'b', 'running'), /already owned/)
  transitionTask(store, 'run', 'a', 'done', { agent: 'child' })
  assert.throws(() => transitionTask(store, 'run', 'c', 'running', { agent: 'child' }), /Coordinator/)
  transitionTask(store, 'run', 'c', 'running')
  assert.throws(() => transitionTask(store, 'run', 'c', 'done'), /Finish gates/)
  recordGate(store, 'run', 'device', 'physical-device-receipt')
  transitionTask(store, 'run', 'c', 'done')
  assert.throws(() => startRun(store, { root: directory, dag: { nodes: [{ id: 'x', depends_on: ['x'] }] } }), /cycle/)
})

test('root explicitly delegates a frozen coordinator node without changing its DAG or blocked history', async t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'delegated', root: directory, dag: { nodes: [{ id: 'work', executor: 'coordinator', finish_gates: ['review'] }] } })
  const frozen = store.db.prepare('SELECT dag FROM runs WHERE id=?').get('delegated').dag
  transitionTask(store, 'delegated', 'work', 'running')
  transitionTask(store, 'delegated', 'work', 'blocked', { reason: 'Waiting for the shared runtime' })
  const assign = (agent: string, target = 'worker') => profileCli(['profile', 'task', '--db', store.location,
    '--run', 'delegated', '--node', 'work', '--agent', agent, '--assign', target, '--reason', 'Root hands over the original reading task'])
  await assert.rejects(assign('worker'), /Only root/)
  await assign('root')
  assert.equal(store.db.prepare('SELECT dag FROM runs WHERE id=?').get('delegated').dag, frozen)
  const context = taskContext(store, 'delegated', 'work')
  assert.equal(context.node.executor, 'coordinator', 'the historical definition stays readable')
  assert.ok(context.assignment)
  assert.equal(context.assignment.assignee, 'worker')
  assert.equal(context.assignment.assignedBy, 'root')
  assert.throws(() => transitionTask(store, 'delegated', 'work', 'running', { agent: 'another' }), /assigned to worker/)
  transitionTask(store, 'delegated', 'work', 'running', { agent: 'worker' })
  await assert.rejects(assign('root', 'replacement'), /running/)
  assert.throws(() => transitionTask(store, 'delegated', 'work', 'done'), /task owner/)
  assert.throws(() => transitionTask(store, 'delegated', 'work', 'done', { agent: 'worker' }), /Finish gates/)
  recordGate(store, 'delegated', 'review', 'targeted-review-evidence')
  transitionTask(store, 'delegated', 'work', 'done', { agent: 'worker' })
  await assert.rejects(assign('root'), /Completed/)
  const report = profileReport(store, 'delegated')
  const blocked = report.spans.find(span => span.kind === 'task' && span.label === 'blocked')
  const resumed = report.spans.find(span => span.kind === 'task' && span.label === 'running' && span.agent === 'worker')
  assert.ok(blocked); assert.ok(resumed)
  assert.equal(report.tasks[0].agent, 'worker')
  assert.equal(report.tasks[0].blockedMs, resumed.started - blocked.started, 'delegation is not a task transition or the end of a wait')
  assert.equal(report.spans.filter(span => span.kind === 'task-assignment').length, 1)
})

test('root assignment does not bypass dependencies, gates, exclusive scopes or parallel slots', t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'constraints', root: directory, dag: { nodes: [
    { id: 'dep' }, { id: 'shared', write_files: ['reader.ts'] },
    { id: 'slot1' }, { id: 'slot2' }, { id: 'slot3' },
    { id: 'work', executor: 'coordinator', depends_on: ['dep'], start_gates: ['runtime'], write_files: ['reader.ts'] },
  ] } })
  assert.throws(() => assignTask(store, 'constraints', 'work', 'worker'), /reason/)
  assignTask(store, 'constraints', 'work', 'worker', { reason: 'Explicit root dispatch' })
  assert.throws(() => transitionTask(store, 'constraints', 'work', 'running', { agent: 'worker' }), /Dependencies/)
  transitionTask(store, 'constraints', 'dep', 'running'); transitionTask(store, 'constraints', 'dep', 'done')
  assert.throws(() => transitionTask(store, 'constraints', 'work', 'running', { agent: 'worker' }), /Start gates/)
  recordGate(store, 'constraints', 'runtime', 'runtime-released')
  transitionTask(store, 'constraints', 'shared', 'running', { agent: 'peer' })
  assert.throws(() => transitionTask(store, 'constraints', 'work', 'running', { agent: 'worker' }), /already owned/)
  for (const id of ['slot1', 'slot2', 'slot3']) transitionTask(store, 'constraints', id, 'running')
  assert.throws(() => transitionTask(store, 'constraints', 'work', 'running', { agent: 'worker' }), /No agent slot/)
  transitionTask(store, 'constraints', 'slot1', 'done')
  transitionTask(store, 'constraints', 'shared', 'done', { agent: 'peer' })
  transitionTask(store, 'constraints', 'work', 'running', { agent: 'worker' })
  assert.equal(taskContext(store, 'constraints', 'work').reporting.agent, 'worker')
  finishRun(store, 'constraints', 'incomplete')
  assert.throws(() => assignTask(store, 'constraints', 'work', 'root', { reason: 'Too late' }), /closed/)
})

test('assignment CLI cannot combine dispatch and a task state transition', async t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'separate', root: directory })
  await assert.rejects(profileCli(['profile', 'task', '--db', store.location, '--run', 'separate', '--node', 'work',
    '--assign', 'worker', '--agent', 'root', '--reason', 'Explicit dispatch', '--state', 'running']), /separate actions/)
  assert.equal(taskContext(store, 'separate', 'work').assignment, null)
  assert.equal(profileReport(store, 'separate').tasks[0].state, 'ready')
})

test('concurrent processes preserve all profile records through SQLite transactions', async t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'run', root: directory })
  const module = new URL('../scripts/development/store.mjs', import.meta.url).href
  const profile = new URL('../scripts/development/profile.mjs', import.meta.url).href
  await Promise.all([0, 1, 2].map(index => new Promise<void>((resolve, reject) => {
    const code = `import {openStore} from ${JSON.stringify(module)};import {startSpan,finishSpan} from ${JSON.stringify(profile)};const s=openStore(process.argv[1]);for(let i=0;i<12;i++){const id=startSpan(s,{run:'run',node:null,parent:null,agent:'child-${index}',label:'tool'});finishSpan(s,id,{status:'passed'})}s.close()`
    // Do not inherit execArgv: the shared-suite runner may include --test,
    // which cannot be combined with this inline -e child program.
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, store.location], { stdio: 'pipe' })
    let stderr = ''; child.stderr.on('data',data=>{stderr+=data})
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Child failed: ${code}: ${stderr.slice(-2000)}`)))
  })))
  assert.equal(profileReport(store, 'run').spans.length, 36)
})

test('command instrumentation preserves failure and timeout and never stores arguments or output', async t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'run', root: directory })
  const secret = 'synthetic-sensitive-payload'
  const failure = await runCommand(store, { run: 'run', label: 'fixture failure', command: [process.execPath, '-e', `console.log('${secret}');process.exit(7)`], cwd: directory, stdio: 'ignore' })
  assert.equal(failure.exitCode, 7)
  const timeout = await runCommand(store, { run: 'run', label: 'fixture timeout', command: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeoutMs: 100, stdio: 'ignore' })
  assert.equal(timeout.exitCode, 124)
  const report = profileReport(store, 'run')
  assert.deepEqual(report.spans.map(s => s.status), ['failed', 'timed-out'])
  assert.ok(!JSON.stringify(report).includes(secret))
})

test('Codex import is idempotent, bounded by the run and strips transcript content', async t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'run', root: directory, now: 2000 })
  const usage = n => ({ type: 'token_count', info: { total_token_usage: { input_tokens: n, output_tokens: n / 2, cached_input_tokens: 0 } } })
  const events = [
    { type: 'session_meta', payload: { id: 'synthetic-session', cwd: directory } },
    { timestamp: new Date(1000).toISOString(), type: 'event_msg', payload: usage(10) },
    { timestamp: new Date(2100).toISOString(), type: 'response_item', payload: { type: 'function_call', call_id: 'call', name: 'exec', arguments: 'synthetic-secret' } },
    { timestamp: new Date(2200).toISOString(), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: 'synthetic-secret' } },
    { timestamp: new Date(2300).toISOString(), type: 'event_msg', payload: usage(30) },
  ]
  const file = join(directory, 'rollout.jsonl')
  writeFileSync(file, events.map(row => JSON.stringify(row)).join('\n') + '\n{partial')
  await importCodex(store, 'run', file)
  await importCodex(store, 'run', file)
  const report = profileReport(store, 'run')
  assert.equal(report.spans.length, 1)
  assert.equal(report.spans[0].status, 'observed')
  assert.equal(report.usage[0].input, 20)
  assert.equal(report.usage[0].output, 10)
  assert.ok(report.usage[0].warnings.some(w => w.includes('partial')))
  assert.ok(!JSON.stringify(report).includes('synthetic-secret'))
})

test('cancelled RSI library cannot create workers or evaluation records', async t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'source', root: directory })
  await assert.rejects(evaluatePolicy(store, { candidate: 'anything', suiteFile: '/not-read' }), /cancelled by the user/)
  assert.equal(store.db.prepare('SELECT count(*) n FROM evaluations').get().n, 0)
  assert.equal(store.db.prepare('SELECT count(*) n FROM runs').get().n, 1)
})

// Preserve the interpretation of historical rows without executing another experiment.
test('historical RSI comparisons and policy rollback remain readable', t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'source', root: directory })
  const baseline = policyRecord(store).document
  proposePolicy(store, { id: 'candidate', document: baseline, hypothesis: 'Historical fixture', evidenceRun: 'source' })
  const suite = { cases: [{ split: 'development' }, { split: 'holdout' }], repetitions: 2, objective: { metric: 'passRate', minGain: .5 } }
  const rows = suite.cases.flatMap(c => [0,1].flatMap(repetition => ['baseline','candidate'].map(variant => ({
    split: c.split, repetition, variant, valid: true, passed: variant === 'candidate' }))))
  assert.equal(compareResults(suite, rows).eligible, true)
  assert.equal(compareResults(suite, []).eligible, false)
  store.db.prepare('INSERT INTO evaluations VALUES(?,?,?,?,?,?,?,?)').run('historical', 'candidate', 'baseline-v1', JSON.stringify(suite), 'completed', 1, 2, JSON.stringify(rows))
  promotePolicy(store, 'historical')
  assert.equal(policyRecord(store).id, 'candidate')
  assert.equal(taskContext(store, 'source', 'work').policy, 'baseline-v1')
  rollbackPolicy(store, 'Historical rollback compatibility')
  assert.equal(policyRecord(store).id, 'baseline-v1')
})

test('profile records dependency-ready waiting and blocked work separately', t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'timing', root: directory, now: 1000, dag: { nodes: [{ id: 'a' }, { id: 'b', depends_on: ['a'] }] } })
  transitionTask(store, 'timing', 'a', 'running', { now: 1100 })
  transitionTask(store, 'timing', 'a', 'blocked', { now: 1200, reason: 'fixture dependency' })
  transitionTask(store, 'timing', 'a', 'running', { now: 1400 })
  transitionTask(store, 'timing', 'a', 'done', { now: 1500 })
  const report = profileReport(store, 'timing', 1700)
  assert.equal(report.tasks.find(t => t.node === 'a').initialQueueMs, 100)
  assert.equal(report.tasks.find(t => t.node === 'a').blockedMs, 200)
  assert.equal(report.tasks.find(t => t.node === 'b').initialQueueMs, 200)
})

test('evidence-backed cancellation preserves the frozen plan, removes only its dependency and never counts as completion', t => {
  const { store, directory } = fixture(t)
  const dag = { nodes: [{ id: 'S2' }, { id: 'real' }, { id: 'V3', depends_on: ['S2', 'real'] }] }
  startRun(store, { id: 'scope', root: directory, dag, checks: [
    { requirement: 'rsi', layer: 'experiment', node: 'S2' }, { requirement: 'real-path', layer: 'browser', node: 'real' },
  ] })
  assert.throws(() => transitionTask(store, 'scope', 'S2', 'cancelled', { reason: 'User cancelled RSI' }), /evidence/)
  assert.throws(() => transitionTask(store, 'scope', 'S2', 'cancelled', { agent: 'worker', reason: 'User cancelled RSI', evidence: 'user-instruction' }), /root/)
  transitionTask(store, 'scope', 'S2', 'cancelled', { reason: 'User cancelled RSI', evidence: 'user-instruction' })
  let report = profileReport(store, 'scope')
  assert.deepEqual(report.run.dag, dag)
  assert.equal(report.tasks.filter(t => t.state === 'done').length, 0)
  assert.equal(report.coverage.find(c => c.node === 'S2').status, 'unknown')
  assert.equal(report.coverage.find(c => c.node === 'S2').cancelled, true)
  assert.equal(report.spans.find(s => s.label === 'cancelled').data.evidence, 'user-instruction')
  assert.equal(readyTasks(store, 'scope').candidates.some(n => n.id === 'V3'), false)
  assert.throws(() => transitionTask(store, 'scope', 'V3', 'running'), /Dependencies/)
  transitionTask(store, 'scope', 'real', 'running')
  assert.throws(() => transitionTask(store, 'scope', 'real', 'cancelled', { reason: 'cancel', evidence: 'user' }), /Invalid task transition/)
  transitionTask(store, 'scope', 'real', 'done')
  const candidate = readyTasks(store, 'scope').candidates.find(n => n.id === 'V3')
  assert.deepEqual(candidate.effectiveDependsOn, ['real'])
  assert.deepEqual(candidate.cancelledDependencies, ['S2'])
  assert.deepEqual(taskContext(store, 'scope', 'V3').execution.cancelledDependencies, ['S2'])
  transitionTask(store, 'scope', 'V3', 'running'); transitionTask(store, 'scope', 'V3', 'done')
  assert.throws(() => finishRun(store, 'scope'), /Incomplete/)
  observe(store, 'scope', { requirement: 'real-path', layer: 'browser', status: 'passed', evidence: 'actual-browser' })
  finishRun(store, 'scope')
  report = profileReport(store, 'scope')
  assert.equal(report.tasks.filter(t => t.state === 'done').length, 2)
  assert.equal(report.tasks.filter(t => t.state === 'cancelled').length, 1)
})

test('current progress updates obsolete blocker detail without completing work or ending blocked time', t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'progress', root: directory, now: 1000 })
  transitionTask(store, 'progress', 'work', 'running', { now: 1100 })
  transitionTask(store, 'progress', 'work', 'blocked', { now: 1200, reason: 'Build failed' })
  recordProgress(store, 'progress', { node: 'work', title: '阅读性能', summary: '构建已完成，待正式性能验收', status: 'waiting', evidence: 'successful-build-log', now: 1300 })
  assert.throws(() => recordProgress(store, 'progress', { title: 'Missing evidence', summary: 'working', status: 'working' }), /evidence/)
  const report = profileReport(store, 'progress', 1500)
  assert.equal(report.tasks[0].state, 'blocked')
  assert.equal(report.tasks[0].reason, '构建已完成，待正式性能验收')
  assert.equal(report.tasks[0].blockedMs, 300)
  assert.equal(report.spans.find(s => s.kind === 'task' && s.label === 'blocked').data.reason, 'Build failed')
  assert.equal(report.progress[0].status, 'waiting')
})

test('dashboard leads with current work and pending activation and accepts the running collector feed without restarting it', t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'live-scope', root: directory, dag: { nodes: [{ id: 'S2', title: 'RSI' }, { id: 'I6', title: '阅读性能' }] } })
  transitionTask(store, 'live-scope', 'S2', 'cancelled', { reason: '用户取消 RSI', evidence: 'user-instruction' })
  transitionTask(store, 'live-scope', 'I6', 'running'); transitionTask(store, 'live-scope', 'I6', 'blocked', { reason: '待正式性能验收' })
  recordProgress(store, 'live-scope', { title: '阅读性能', node: 'I6', summary: '构建完成，待正式性能验收', status: 'waiting', evidence: 'build-log' })
  recordProgress(store, 'live-scope', { title: '原生请求恢复', summary: '调查重连后的 pending 问题', status: 'working', evidence: 'native-investigation' })
  recordProgress(store, 'live-scope', { title: 'Files 生产热修复', summary: 'installer 正在激活，尚未确认上线', status: 'pending-release', evidence: 'installer-log' })
  const output = join(directory, 'dashboard.html')
  writeDashboard(store, { output })
  const dom = new JSDOM(readFileSync(output, 'utf8'), { runScripts: 'dangerously' })
  t.after(() => dom.window.close())
  const document = dom.window.document
  assert.match(document.querySelector('#current-work').textContent, /调查重连后的 pending/)
  assert.doesNotMatch(document.querySelector('#current-work').textContent, /待正式性能验收/)
  assert.match(document.querySelector('#current-blockers').textContent, /待正式性能验收/)
  assert.match(document.querySelector('#pending-release').textContent, /尚未确认上线/)
  assert.match(document.querySelector('#scope-changes').textContent, /S2.*已取消/)
  assert.match(document.querySelector('#metrics').textContent, /0 完成 \/ 1 有效/)
  assert.doesNotMatch(document.body.textContent, /节点完成不代替行为验收|已完成任务/)
  recordProgress(store, 'live-scope', { title: 'Files 生产热修复', summary: '激活结果已核对', status: 'released', evidence: 'actual-activation-result', now: Date.now() + 100 })
  const legacyFeed = dashboardSnapshot(store)
  delete legacyFeed.run.progress
  legacyFeed.generatedAt += 100
  dom.window.updateProfile(legacyFeed)
  assert.doesNotMatch(document.querySelector('#pending-release').textContent, /Files 生产热修复/)
  assert.match(document.querySelector('#recent-results').textContent, /激活结果已核对.*已上线/)
  assert.match(document.querySelector('#current-work').textContent, /原生请求恢复/)
})

test('HTML report escapes labels and shows unknown coverage explicitly', t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: '<script>bad</script>', root: directory, checks: [{ requirement: 'menu', layer: 'browser' }] })
  const file = join(directory, 'report.html')
  writeReport(profileReport(store, '<script>bad</script>'), file)
  const html = readFileSync(file, 'utf8')
  assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'))
  assert.ok(!html.includes('<script>bad</script>'))
  assert.ok(html.includes('unknown'))
})

test('dashboard consumes live records, keeps tabs usable and excludes policy source and task payloads', t => {
  const { store, directory } = fixture(t)
  startRun(store, { id: 'visible-run', root: directory, checks: [{ requirement: 'secondary-menu', layer: 'browser' }] })
  proposePolicy(store, { id: 'candidate', document: { ...policyRecord(store).document, harnessFiles: { 'worker.mjs': 'private-fixture-source' } }, hypothesis: 'Fixture change', evidenceRun: 'visible-run' })
  const attributionDirectory = join(directory, 'artifacts/development/visible-run')
  mkdirSync(attributionDirectory, { recursive: true })
  writeFileSync(join(attributionDirectory, 'work-attribution.json'), JSON.stringify({
    schemaVersion: 1, run: 'visible-run', title: '实际耗时归因', scope: '固定开发窗口', measurement: '同类重叠去重',
    findings: [{ title: '安装反复失败', detail: '没有得到可用安装', evidence: 'span-id', command: 'private-raw-command' }],
    groups: [{ title: '安装', count: 2, unionMs: 60000, note: '失败后改安装路径', transcript: 'private-transcript' }],
    remaining: '推理尚未按任务归因', evidence: 'local-index', rawTranscript: 'private-top-level',
  }))
  const output = join(directory, 'dashboard.html')
  writeDashboard(store, { output })
  const dom = new JSDOM(readFileSync(output, 'utf8'), { runScripts: 'dangerously' })
  t.after(() => dom.window.close())
  const document = dom.window.document
  assert.match(document.querySelector('#work-attribution').textContent, /安装反复失败/)
  assert.match(document.querySelector('#work-attribution').textContent, /1.0 分/)
  assert.doesNotMatch(document.body.textContent, /活动已定位/)
  assert.match(document.querySelector('#coverage').textContent, /未验证/)
  document.querySelector('[data-tab="rsi"]').click()
  assert.equal(document.querySelector('#rsi').classList.contains('hidden'), false)
  observe(store, 'visible-run', { requirement: 'secondary-menu', layer: 'browser', status: 'failed', evidence: 'fixture-evidence' })
  const snapshot = dashboardSnapshot(store)
  dom.window.updateProfile(snapshot)
  assert.match(document.querySelector('#coverage').textContent, /失败/)
  assert.equal(document.querySelector('#rsi').classList.contains('hidden'), false)
  assert.ok(!JSON.stringify(snapshot).includes('private-fixture-source'))
  assert.ok(!JSON.stringify(snapshot).includes('private-raw-command'))
  assert.ok(!JSON.stringify(snapshot).includes('private-transcript'))
  assert.ok(!JSON.stringify(snapshot).includes('private-top-level'))
  assert.ok(!JSON.stringify(snapshot).includes(directory))
  writeDashboard(store, { output, initial: false })
  assert.match(readFileSync(`${output}.data.js`, 'utf8'), /window.updateProfile/)
})
