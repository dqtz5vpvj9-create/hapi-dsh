import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { executionInstructions } from './execution.mjs'
import { activityReport } from './activity.mjs'
import { resolve } from 'node:path'
import { decode, policyRecord, runRecord, transaction, uid } from './store.mjs'

export function initializePolicy(store) {
  const document = readFileSync(new URL('./baseline-policy.json', import.meta.url), 'utf8')
  transaction(store, () => {
    store.db.prepare('INSERT OR IGNORE INTO policies VALUES(?,?,?,?,?,?)')
      .run('baseline-v1', null, document, 'Initial development policy; effectiveness not yet measured.', null, Date.now())
    store.db.prepare('INSERT OR IGNORE INTO active_policy VALUES(1,?)').run('baseline-v1')
  })
}

export function validateDag(dag) {
  if (!Array.isArray(dag.nodes) || !dag.nodes.length) throw new Error('DAG needs nodes')
  const map = new Map(dag.nodes.map(node => [node.id, node]))
  if (map.size !== dag.nodes.length) throw new Error('Duplicate DAG node')
  const visiting = new Set(), visited = new Set()
  const visit = id => {
    if (visiting.has(id)) throw new Error(`DAG cycle: ${id}`)
    if (visited.has(id)) return
    const node = map.get(id)
    if (!node) throw new Error(`Missing DAG predecessor: ${id}`)
    if (typeof id !== 'string' || !id) throw new Error('Node needs an id')
    visiting.add(id)
    for (const dep of node.depends_on || []) visit(dep)
    visiting.delete(id); visited.add(id)
  }
  for (const id of map.keys()) visit(id)
}

export function startRun(store, { id = uid(), root = process.cwd(), dag = { nodes: [{ id: 'work', title: 'Development work', depends_on: [] }] }, checks = [], policy, now = Date.now() } = {}) {
  validateDag(dag)
  const checkIds = new Set()
  for (const check of checks) {
    if (!check.requirement || !check.layer || checkIds.has(`${check.requirement}:${check.layer}`)) throw new Error('Checks need unique requirement/layer pairs')
    if (check.node && !dag.nodes.some(node => node.id === check.node)) throw new Error('Check refers to an unknown node')
    checkIds.add(`${check.requirement}:${check.layer}`)
  }
  initializePolicy(store)
  const chosen = policyRecord(store, policy)
  const directory = resolve(root)
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' }).trim()
  let revision = null, changed = []
  try {
    revision = git(['rev-parse', 'HEAD'])
    changed = git(['status', '--porcelain=v1', '-z']).split('\0').filter(Boolean)
  } catch { /* Non-Git fixtures have no revision; do not invent one. */ }
  transaction(store, () => {
    store.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, now, null, 'running', directory,
      revision, JSON.stringify(changed), JSON.stringify(dag), JSON.stringify(checks), chosen.id)
    const insert = store.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)')
    for (const node of dag.nodes) insert.run(id, node.id, 'pending', null, null, null, null, null)
    releaseReadyTasks(store, id, dag, now)
  })
  return { id, policy: chosen.id, database: store.location, started: now }
}

function taskState(store, run) {
  return new Map(store.db.prepare('SELECT * FROM tasks WHERE run=?').all(run).map(row => [row.node, row]))
}

const dependencySatisfied = task => ['done', 'cancelled'].includes(task?.state)

function missingGates(store, run, gates) {
  const ready = new Set(store.db.prepare('SELECT name FROM gates WHERE run=?').all(run).map(row => row.name))
  return (gates || []).filter(gate => !ready.has(gate))
}

function releaseReadyTasks(store, runId, dag, now) {
  const states = taskState(store, runId)
  for (const node of dag.nodes) {
    if (states.get(node.id).state === 'pending' && (node.depends_on || []).every(id => dependencySatisfied(states.get(id)))
      && !missingGates(store, runId, node.start_gates).length) {
      store.db.prepare('UPDATE tasks SET state=?,ready=? WHERE run=? AND node=?').run('ready', now, runId, node.id)
    }
  }
}

function conflicts(a, b) {
  const fields = ['write_files', 'new_files', 'exclusive_resources']
  const left = [...(a.write_files || []), ...(a.new_files || [])]
  const right = [...(b.write_files || []), ...(b.new_files || [])]
  return [...left.filter(file => right.includes(file)), ...(a[fields[2]] || []).filter(resource => (b[fields[2]] || []).includes(resource))]
}

export function readyTasks(store, runId) {
  const run = runRecord(store, runId), states = taskState(store, runId)
  const policy = policyRecord(store, run.policy).document
  const active = run.dag.nodes.filter(node => states.get(node.id).state === 'running')
  const ranks = new Map()
  const rank = id => {
    if (!ranks.has(id)) ranks.set(id, 1 + Math.max(0, ...run.dag.nodes.filter(n => (n.depends_on || []).includes(id)).map(n => rank(n.id))))
    return ranks.get(id)
  }
  const candidates = run.dag.nodes.filter(node => ['pending', 'ready'].includes(states.get(node.id).state)
    && (node.depends_on || []).every(id => dependencySatisfied(states.get(id)))
    && !missingGates(store, runId, node.start_gates).length)
    .map(node => ({ ...node, effectiveDependsOn: (node.depends_on || []).filter(id => states.get(id).state !== 'cancelled'),
      cancelledDependencies: (node.depends_on || []).filter(id => states.get(id).state === 'cancelled'),
      remainingDepth: rank(node.id), conflicts: active.flatMap(other => conflicts(node, other)) }))
  if (policy.scheduling === 'critical-path') candidates.sort((a, b) => b.remainingDepth - a.remainingDepth)
  return { availableSlots: Math.max(0, policy.maxParallel - active.length), running: active.map(n => n.id),
    rankingBasis: policy.scheduling === 'critical-path' ? 'dependency depth, not a measured duration estimate' : 'DAG order', candidates }
}

function taskAssignment(store, runId, nodeId) {
  const row = store.db.prepare('SELECT data,started FROM spans WHERE run=? AND node=? AND kind=? ORDER BY started DESC,rowid DESC LIMIT 1')
    .get(runId, nodeId, 'task-assignment')
  return row ? { ...decode(row.data), at: row.started } : null
}

/** Root dispatch is explicit metadata; it neither rewrites the frozen DAG nor acquires resources. */
export function assignTask(store, runId, nodeId, assignee, { agent = 'root', reason, now = Date.now() } = {}) {
  return transaction(store, () => {
    const run = runRecord(store, runId)
    if (run.status !== 'running') throw new Error('Run is closed')
    const node = run.dag.nodes.find(item => item.id === nodeId)
    if (!node) throw new Error(`Unknown node: ${nodeId}`)
    if (agent !== 'root') throw new Error('Only root can assign a task')
    if (!assignee?.trim() || !reason?.trim()) throw new Error('Assignment needs an assignee and reason')
    const old = taskState(store, runId).get(nodeId)
    if (old.state === 'running') throw new Error('Cannot assign running work; its owner must block before handoff')
    if (['done', 'cancelled'].includes(old.state)) throw new Error('Completed or cancelled work cannot be reassigned')
    const previous = taskAssignment(store, runId, nodeId)
    const assignment = { assignedBy: agent, assignee, previousAssignee: previous?.assignee ?? null,
      reason, state: old.state, executor: node.executor ?? 'any' }
    store.db.prepare('INSERT INTO spans VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(uid(), runId, nodeId, agent, null,
      'task-assignment', 'assigned', now, now, 'recorded', JSON.stringify(assignment))
    return { node: nodeId, ...assignment }
  })
}

export function transitionTask(store, runId, nodeId, state, { agent = 'root', reason, evidence, now = Date.now() } = {}) {
  return transaction(store, () => {
    const run = runRecord(store, runId)
    if (run.status !== 'running') throw new Error('Run is closed')
    const node = run.dag.nodes.find(item => item.id === nodeId)
    if (!node) throw new Error(`Unknown node: ${nodeId}`)
    const states = taskState(store, runId), old = states.get(nodeId)
    const transitions = { pending: ['ready', 'running', 'cancelled'], ready: ['running', 'cancelled'], running: ['blocked', 'done'], blocked: ['ready', 'running', 'cancelled'] }
    if (!transitions[old.state]?.includes(state)) throw new Error(`Invalid task transition: ${old.state} -> ${state}`)
    if (state === 'cancelled' && (agent !== 'root' || !reason?.trim() || !evidence?.trim())) throw new Error('Cancellation needs root, an explicit reason and evidence')
    if (old.state === 'running' && old.agent !== agent) throw new Error('Only the task owner can finish or block running work')
    if (state === 'ready' || state === 'running') {
      if (!(node.depends_on || []).every(id => dependencySatisfied(states.get(id)))) throw new Error('Dependencies are incomplete')
      if (missingGates(store, runId, node.start_gates).length) throw new Error('Start gates are incomplete')
    }
    if (state === 'running') {
      const assignment = taskAssignment(store, runId, nodeId)
      if (assignment && assignment.assignee !== agent) throw new Error(`Task is assigned to ${assignment.assignee}`)
      if (node.executor === 'coordinator' && agent !== 'root' && assignment?.assignee !== agent) throw new Error('Coordinator owns this node')
      const other = run.dag.nodes.filter(n => states.get(n.id).state === 'running')
      if (other.length >= policyRecord(store, run.policy).document.maxParallel) throw new Error('No agent slot available')
      if (other.some(n => conflicts(node, n).length)) throw new Error('Write scope or exclusive resource is already owned')
    }
    if (state === 'done' && missingGates(store, runId, node.finish_gates).length) throw new Error('Finish gates are incomplete')
    if (state === 'blocked' && !reason) throw new Error('Blocked tasks need a reason')
    store.db.prepare('UPDATE tasks SET state=?,agent=?,ready=?,started=?,finished=?,reason=? WHERE run=? AND node=?')
      .run(state, agent, state === 'cancelled' ? old.ready : old.ready ?? now, state === 'running' ? old.started ?? now : old.started,
        ['done', 'cancelled'].includes(state) ? now : null, reason ?? null, runId, nodeId)
    store.db.prepare('INSERT INTO spans VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(uid(), runId, nodeId, agent, null, 'task',
      state, now, now, 'recorded', JSON.stringify({ from: old.state, reason: reason ?? null, ...(evidence ? { evidence } : {}) }))
    if (['done', 'cancelled'].includes(state)) releaseReadyTasks(store, runId, run.dag, now)
    return { node: nodeId, state }
  })
}

/** Current execution notes are evidence-backed metadata, not task completion or resource claims. */
export function recordProgress(store, runId, { title, summary, status, evidence, node = null, agent = 'root', now = Date.now() }) {
  return transaction(store, () => {
    const run = runRecord(store, runId)
    if (run.status !== 'running') throw new Error('Run is closed')
    if (!title?.trim() || title.includes(' · ') || !summary?.trim() || !evidence?.trim()) throw new Error('Progress needs a stable title, summary and evidence')
    if (!['working', 'waiting', 'blocked', 'pending-release', 'released', 'completed'].includes(status)) throw new Error('Invalid progress status')
    const task = node && taskState(store, runId).get(node)
    if (node && !task) throw new Error(`Unknown node: ${node}`)
    const id = uid()
    // Keep a readable label/status so an already-running collector can publish
    // new execution notes without being restarted or losing its private env.
    store.db.prepare('INSERT INTO spans VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, runId, node, agent, null, 'progress',
      `${title} · ${summary}`, now, now, status, JSON.stringify({ title, summary, evidence }))
    if (task?.state === 'blocked' && ['waiting', 'blocked'].includes(status) && (agent === 'root' || task.agent === agent)) {
      store.db.prepare('UPDATE tasks SET reason=? WHERE run=? AND node=?').run(summary, runId, node)
    }
    return { id, title, summary, status, evidence, node, agent, at: now }
  })
}

export function recordGate(store, runId, name, evidence) {
  transaction(store, () => {
    const run = runRecord(store, runId)
    if (run.status !== 'running') throw new Error('Run is closed')
    const known = run.dag.nodes.flatMap(node => [...(node.start_gates || []), ...(node.finish_gates || [])])
    if (!known.includes(name) || !evidence?.trim()) throw new Error('Gate needs a declared name and evidence locator')
    store.db.prepare('INSERT INTO gates VALUES(?,?,?) ON CONFLICT(run,name) DO UPDATE SET evidence=excluded.evidence').run(runId, name, evidence)
    releaseReadyTasks(store, runId, run.dag, Date.now())
  })
}

export function startSpan(store, { run, node = process.env.HHPI_PROFILE_NODE || null, agent = process.env.HHPI_PROFILE_AGENT || 'unattributed', parent = process.env.HHPI_PROFILE_PARENT || null, kind = 'command', label, data = {}, now = Date.now(), id = uid() }) {
  const record = runRecord(store, run)
  if (record.status !== 'running') throw new Error('Run is closed')
  if (node && !record.dag.nodes.some(n => n.id === node)) throw new Error(`Unknown node: ${node}`)
  if (!label) throw new Error('Span needs a non-sensitive label')
  store.db.prepare('INSERT INTO spans VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, run, node, agent, parent, kind, label, now, null, 'running', JSON.stringify(data))
  return id
}

export function finishSpan(store, id, { status, data = {}, now = Date.now() }) {
  const old = store.db.prepare('SELECT * FROM spans WHERE id=?').get(id)
  if (!old || old.finished !== null) throw new Error('Span is missing or already finished')
  if (!['passed', 'failed', 'cancelled', 'timed-out', 'not-run', 'observed'].includes(status) || now < old.started) throw new Error('Invalid span outcome')
  store.db.prepare('UPDATE spans SET finished=?,status=?,data=? WHERE id=?').run(now, status, JSON.stringify({ ...decode(old.data), ...data }), id)
}

export function observe(store, runId, { requirement, layer, status, evidence, discoveredBy = 'agent', now = Date.now() }) {
  runRecord(store, runId)
  // New user paths can be discovered working as well as broken. Recording an
  // honest result must not require inventing a preceding failure. The report
  // appends this exact requirement/layer; it never replaces frozen obligations.
  if (!requirement?.trim() || !layer?.trim()) throw new Error('Observation needs requirement and layer')
  if (!['passed', 'failed', 'unknown'].includes(status)) throw new Error('Invalid observation status')
  if (status !== 'unknown' && !evidence?.trim()) throw new Error('Outcome needs an evidence locator')
  if (!['agent', 'independent-review', 'user'].includes(discoveredBy)) throw new Error('Unknown discovery source')
  const id = uid()
  store.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?)').run(id, runId, requirement, layer, status, evidence || '', discoveredBy, now)
  return id
}

export function unionDuration(intervals) {
  const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).sort((a, b) => a[0] - b[0])
  let total = 0, end = -Infinity
  for (const [a, b] of sorted) { total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b) }
  return total
}

export function profileReport(store, runId, now = Date.now()) {
  const run = runRecord(store, runId)
  const spans = store.db.prepare('SELECT * FROM spans WHERE run=? ORDER BY started,id').all(runId).map(row => ({ ...row, data: decode(row.data) }))
  const observations = store.db.prepare('SELECT rowid AS sequence,* FROM observations WHERE run=? ORDER BY created,sequence').all(runId)
  const checks = [...run.checks]
  for (const observation of observations) if (!checks.some(c => c.requirement === observation.requirement && c.layer === observation.layer)) {
    checks.push({ requirement: observation.requirement, layer: observation.layer, addedAfterStart: true })
  }
  const states = taskState(store, runId)
  const coverage = checks.map(check => ({ ...check, ...(observations.filter(o => o.requirement === check.requirement && o.layer === check.layer).at(-1) || { status: 'unknown', evidence: '' }),
    ...(states.get(check.node)?.state === 'cancelled' ? { cancelled: true } : {}) }))
  const intervals = spans.filter(s => s.finished !== null && s.kind !== 'task').map(s => [s.started, s.finished])
  const byKind = {}
  for (const span of spans.filter(s => s.kind !== 'task')) {
    const row = byKind[span.kind] ||= { count: 0, inclusiveMs: 0, unfinished: 0, failed: 0 }
    row.count++; row.inclusiveMs += span.finished === null ? 0 : span.finished - span.started
    row.unfinished += Number(span.finished === null); row.failed += Number(['failed', 'cancelled', 'timed-out'].includes(span.status))
  }
  for (const kind of Object.keys(byKind)) byKind[kind].unionMs = unionDuration(spans.filter(s => s.kind === kind && s.finished !== null).map(s => [s.started, s.finished]))
  const end = run.finished ?? now
  const tasks = [...states.values()].map(task => {
    const events = spans.filter(s => s.kind === 'task' && s.node === task.node)
    let blockedMs = 0, blockedAt = null
    for (const event of events) {
      if (blockedAt !== null) { blockedMs += event.started - blockedAt; blockedAt = null }
      if (event.label === 'blocked') blockedAt = event.started
    }
    if (blockedAt !== null) blockedMs += end - blockedAt
    return { ...task, initialQueueMs: task.ready === null ? null : (task.started ?? end) - task.ready, blockedMs }
  })
  const issues = []
  const unseen = coverage.filter(c => !c.cancelled && c.status === 'unknown')
  if (unseen.length) issues.push({ kind: 'unobserved-behavior', evidence: unseen.map(c => `${c.requirement}/${c.layer}`), hypothesis: 'Inspect these entry points or states before declaring the scope complete.' })
  const failed = coverage.filter(c => !c.cancelled && c.status === 'failed')
  if (failed.length) issues.push({ kind: 'failed-behavior', evidence: failed.map(c => c.evidence), hypothesis: 'Trace the failed user behavior across its entry point, binding and source result.' })
  const open = spans.filter(s => s.finished === null)
  if (open.length) issues.push({ kind: 'unfinished-observation', evidence: open.map(s => s.id), hypothesis: 'Determine whether work is still running or the process stopped; do not count it as success.' })
  const repetitions = new Map()
  for (const span of spans.filter(s => ['verification', 'product-test'].includes(s.kind))) {
    const key = `${span.node}:${span.label}`
    repetitions.set(key, [...(repetitions.get(key) || []), span.id])
  }
  for (const [label, ids] of repetitions) if (ids.length > 1) issues.push({ kind: 'repeated-verification', evidence: ids, hypothesis: `Check whether relevant code or environment changed between ${label}; repetition alone does not prove wasted work.` })
  const progress = new Map()
  for (const span of spans.filter(s => s.kind === 'progress')) progress.set(span.data.title, { ...span.data, status: span.status, node: span.node, agent: span.agent, at: span.started })
  return { schemaVersion: 1, run, elapsedMs: (run.finished ?? now) - run.started,
    observedUnionMs: unionDuration(intervals), inclusiveWorkMs: intervals.reduce((n, [a, b]) => n + b - a, 0),
    byKind, kindAttribution: 'Caller-declared purpose. Legacy verification is mixed and is not a measurement of product testing.',
    activity: activityReport(store, runId, { until: now }), tasks, progress: [...progress.values()], spans, coverage, observations, issues,
    userReportedFailures: observations.filter(o => o.discovered_by === 'user' && o.status === 'failed').length,
    postDeliveryFailures: observations.filter(o => run.finished !== null && o.created >= run.finished && o.status === 'failed').length,
    usage: store.db.prepare('SELECT * FROM usage WHERE run=?').all(runId).map(row => ({ ...row, warnings: decode(row.warnings) })),
    interpretation: 'Inclusive work overlaps across agents and nested spans. Union is observed time, not CPU time. Overlap does not determine activity purpose. Caller labels are not independently verified. Missing coverage is unknown; observations are evidence-backed attestations, not independently certified outcomes.' }
}

export function finishRun(store, runId, status = 'completed') {
  if (!['completed', 'incomplete', 'cancelled'].includes(status)) throw new Error('Invalid run status')
  const report = profileReport(store, runId)
  if (report.run.status !== 'running') throw new Error('Run is already closed')
  if (status === 'completed' && (report.tasks.some(t => !dependencySatisfied(t)) || report.coverage.some(c => !c.cancelled && c.status !== 'passed') || report.spans.some(s => s.finished === null))) {
    throw new Error('Incomplete tasks, evidence or spans; use incomplete instead of claiming completion')
  }
  store.db.prepare('UPDATE runs SET status=?,finished=? WHERE id=?').run(status, Date.now(), runId)
}

export function taskContext(store, runId, nodeId) {
  const run = runRecord(store, runId), node = run.dag.nodes.find(n => n.id === nodeId)
  if (!node) throw new Error(`Unknown node: ${nodeId}`)
  const policy = policyRecord(store, run.policy).document
  // Dispatch needs this node's evidence, not the complete report, every agent's
  // timeline and all historical token rows on each context request.
  const observations = store.db.prepare('SELECT rowid AS sequence,* FROM observations WHERE run=? ORDER BY created,sequence').all(runId)
  const checks = run.checks.filter(c=>!c.node || c.node===nodeId).map(check=>({ ...check,
    ...(observations.filter(o=>o.requirement===check.requirement && o.layer===check.layer).at(-1) || {status:'unknown',evidence:''}) }))
  const declared = new Set(run.checks.map(c=>`${c.requirement}\0${c.layer}`))
  const discovered = new Map()
  for (const o of observations) if (!declared.has(`${o.requirement}\0${o.layer}`)) discovered.set(`${o.requirement}\0${o.layer}`,{...o,addedAfterStart:true})
  return { run: runId, policy: run.policy, instructions: [...policy.instructions, ...executionInstructions],
    scheduling: { order: policy.scheduling, maxParallel: policy.maxParallel },
    node, execution: { ...taskState(store, runId).get(nodeId), cancelledDependencies: (node.depends_on || []).filter(id => taskState(store, runId).get(id).state === 'cancelled') },
    assignment: taskAssignment(store, runId, nodeId), checks: [...checks,...discovered.values()], reporting: { database: store.location, run: runId, node: nodeId,
      agent: store.db.prepare('SELECT agent FROM tasks WHERE run=? AND node=?').get(runId,nodeId)?.agent ?? null },
    boundary: 'Project development guidance; existing user instructions, authorization and release requirements remain authoritative.' }
}
