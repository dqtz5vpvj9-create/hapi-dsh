import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { policyRecord, runRecord, decode, transaction, uid } from './store.mjs'
import { initializePolicy, profileReport } from './profile.mjs'
import { relativeFile, snapshotHarness } from './harness.mjs'

export function validatePolicy(document) {
  const keys = ['version', 'scheduling', 'maxParallel', 'instructions', 'harnessFiles']
  if (!document || Object.keys(document).some(key => !keys.includes(key)) || document.version !== 1) throw new Error('Unsupported policy schema')
  if (!['critical-path', 'fifo'].includes(document.scheduling) || !Number.isInteger(document.maxParallel) || document.maxParallel < 1 || document.maxParallel > 4) throw new Error('Invalid scheduler policy (current runtime has at most four slots)')
  if (!Array.isArray(document.instructions) || !document.instructions.length || document.instructions.some(s => typeof s !== 'string' || !s.trim())) throw new Error('Policy needs actionable instructions')
  if (document.harnessFiles !== undefined) {
    if (!document.harnessFiles || Array.isArray(document.harnessFiles) || typeof document.harnessFiles !== 'object') throw new Error('Invalid harnessFiles')
    for (const [file, body] of Object.entries(document.harnessFiles)) {
      relativeFile(file)
      if (typeof body !== 'string') throw new Error('Harness file bodies must be text')
    }
  }
}

export function proposePolicy(store, { id = uid(), parent, document, hypothesis, evidenceRun }) {
  initializePolicy(store); validatePolicy(document)
  const base = policyRecord(store, parent)
  const evidence = runRecord(store, evidenceRun)
  if (!hypothesis?.trim()) throw new Error('Candidate needs a testable hypothesis')
  store.db.prepare('INSERT INTO policies VALUES(?,?,?,?,?,?)').run(id, base.id, JSON.stringify(document), hypothesis, evidence.id, Date.now())
  return { id, parent: base.id, status: 'proposed', effective: false }
}

export function improvementBrief(store, runId) {
  const report = profileReport(store, runId)
  return { policy: policyRecord(store, report.run.policy), evidence: { run: runId, byKind: report.byKind, issues: report.issues,
    tasks: report.tasks, coverage: report.coverage, usage: report.usage },
    instruction: 'Use these observations to improve the actual user-path delivery workflow. Identify redundant model involvement, repeated deterministic work and late integration. Preserve historical evidence and check the effect during subsequent real work.',
    evaluation: 'RSI paired experiments are cancelled by the user. Do not launch baseline/candidate workers. Profile collection alone is not evidence of improved delivery efficiency.' }
}

export function loadSuite(file) {
  const suite = JSON.parse(readFileSync(file, 'utf8')), base = dirname(resolve(file))
  if (!suite.id || !Array.isArray(suite.cases) || !suite.cases.length) throw new Error('Suite needs an id and cases')
  for (const field of ['agentCommand', 'verifyCommand']) if (!Array.isArray(suite[field]) || !suite[field].length || suite[field].some(arg => typeof arg !== 'string')) throw new Error(`${field} must be argv`)
  if (!Number.isInteger(suite.repetitions) || suite.repetitions < 2) throw new Error('Use at least two paired repetitions')
  for (const field of ['budgetMs', 'timeoutMs']) if (!Number.isFinite(suite[field]) || suite[field] <= 0) throw new Error(`${field} must be positive`)
  if (!['passRate', 'agentMs', 'score'].includes(suite.objective?.metric) || !Number.isFinite(suite.objective.minGain) || suite.objective.minGain <= 0) throw new Error('Suite needs a fixed objective and positive minGain')
  const ids = new Set()
  for (const item of suite.cases) {
    if (!item.id || ids.has(item.id) || !['development', 'holdout'].includes(item.split)) throw new Error('Cases need unique IDs and explicit splits')
    ids.add(item.id)
    if (!Array.isArray(item.checks) || !item.checks.length || item.checks.some(c => typeof c !== 'string' || !c) || new Set(item.checks).size !== item.checks.length) throw new Error('Cases need nonempty unique checks')
    if (item.fixture) item.fixture = resolve(base, item.fixture)
  }
  if (!suite.cases.some(c => c.split === 'development') || !suite.cases.some(c => c.split === 'holdout')) throw new Error('Both development and holdout cases are required')
  if (suite.harness) {
    suite.harness = snapshotHarness(suite.harness, base)
  }
  return { ...suite, base }
}


export function compareResults(suite, rows) {
  const expected = suite.cases.length * suite.repetitions * 2
  if (rows.length !== expected || rows.some(row => !row.valid)) return { eligible: false, reason: 'Incomplete execution or invalid verifier output' }
  const candidate = rows.filter(r => r.variant === 'candidate'), baseline = rows.filter(r => r.variant === 'baseline')
  if (candidate.some(r => !r.passed)) return { eligible: false, reason: 'Candidate has failed required behavior checks' }
  const metric = suite.objective.metric
  if (metric === 'agentMs' && baseline.some(r => !r.passed)) return { eligible: false, reason: 'Latency comparison requires successful baseline behavior too' }
  if (metric === 'score' && rows.some(r => !Number.isFinite(r.score))) return { eligible: false, reason: 'Score objective lacks measurements' }
  const value = group => group.reduce((n, row) => n + (metric === 'passRate' ? Number(row.passed) : row[metric]), 0) / group.length
  const results = ['development', 'holdout'].map(split => {
    const before = value(baseline.filter(r => r.split === split)), after = value(candidate.filter(r => r.split === split))
    return { split, baseline: before, candidate: after,
      gain: metric === 'agentMs' ? (before - after) / Math.max(1, before) : after - before }
  })
  const eligible = results.every(row => row.gain >= suite.objective.minGain)
  return { eligible, objective: suite.objective, results,
    reason: eligible ? 'All candidate checks passed; improvement threshold met on both splits' : 'Improvement threshold not met on both splits',
    interpretation: 'Eligibility applies to this suite and budget. It is not a statistical or general capability guarantee.' }
}

export async function evaluatePolicy() {
  throw new Error('RSI paired evaluations were cancelled by the user. No workers started.')
}

export function promotePolicy(store, evaluationId) {
  return transaction(store, () => {
    const evaluation = store.db.prepare('SELECT * FROM evaluations WHERE id=?').get(evaluationId)
    if (!evaluation || evaluation.status !== 'completed') throw new Error('A completed evaluation is required')
    const verdict = compareResults(decode(evaluation.suite), decode(evaluation.results))
    if (!verdict.eligible) throw new Error(verdict.reason)
    const active = policyRecord(store)
    if (active.id !== evaluation.baseline) throw new Error('Active policy changed; compare against its current version before promotion')
    store.db.prepare('UPDATE active_policy SET policy=? WHERE singleton=1').run(evaluation.candidate)
    store.db.prepare('INSERT INTO promotions(previous,next,evaluation,reason,created) VALUES(?,?,?,?,?)').run(active.id, evaluation.candidate, evaluationId, verdict.reason, Date.now())
    return { active: evaluation.candidate, previous: active.id, appliesTo: 'new runs; existing runs keep their policy snapshot' }
  })
}

export function rollbackPolicy(store, reason) {
  if (!reason?.trim()) throw new Error('Rollback needs a reason')
  return transaction(store, () => {
    const active = policyRecord(store)
    const last = store.db.prepare('SELECT * FROM promotions WHERE next=? AND evaluation IS NOT NULL ORDER BY id DESC LIMIT 1').get(active.id)
    if (!last) throw new Error('No promoted predecessor to restore')
    store.db.prepare('UPDATE active_policy SET policy=? WHERE singleton=1').run(last.previous)
    store.db.prepare('INSERT INTO promotions(previous,next,evaluation,reason,created) VALUES(?,?,?,?,?)').run(active.id, last.previous, null, reason, Date.now())
    return { active: last.previous, previous: active.id }
  })
}
