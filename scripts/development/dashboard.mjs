import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { decode, policyRecord } from './store.mjs'
import { profileReport } from './profile.mjs'
import { compareResults } from './rsi.mjs'

/** Deliberately excludes transcript text, policy source bodies and evaluation task inputs. */
export function dashboardSnapshot(store, { runId, plan } = {}) {
  const id = runId || store.db.prepare("SELECT id FROM runs WHERE id NOT LIKE 'eval-%' ORDER BY started DESC LIMIT 1").get()?.id
  const report = id ? profileReport(store, id) : null
  const evaluations = store.db.prepare('SELECT * FROM evaluations ORDER BY started DESC').all().map(row => {
    const suite = decode(row.suite), results = decode(row.results)
    return { id: row.id, candidate: row.candidate, baseline: row.baseline, status: row.status,
      started: row.started, finished: row.finished, samples: results.length, expected: suite.cases.length * suite.repetitions * 2,
      comparison: compareResults(suite, results), suite: suite.id }
  })
  const policies = store.db.prepare('SELECT id,parent,hypothesis,evidence_run,created FROM policies ORDER BY created').all()
  const promotions = store.db.prepare('SELECT * FROM promotions ORDER BY id DESC').all()
  let active = null
  if (policies.length) active = policyRecord(store).id
  return { generatedAt: Date.now(), active, policies, evaluations, promotions,
    run: report && { id, status: report.run.status, started: report.run.started, finished: report.run.finished, policy: report.run.policy,
      tasks: report.tasks, nodes: report.run.dag.nodes.map(({ id, title, depends_on, group }) => ({ id, title, depends_on, group })),
      progress: report.progress.map(({ title, summary, status, evidence, node, agent, at }) => ({ title, summary, status, evidence, node, agent, at })),
      spans: report.spans.filter(s => s.kind !== 'task').map(({ id, agent, node, label, kind, started, finished, status }) => ({ id, agent, node, label, kind, started, finished, status })),
      elapsedMs: report.elapsedMs, observedUnionMs: report.observedUnionMs, byKind: report.byKind,
      workAttribution: readWorkAttribution(report.run.root, id),
      activity: { ...report.activity, rows: report.activity.rows.slice(-60) },
      coverage: report.coverage, userReportedFailures: report.userReportedFailures, postDeliveryFailures: report.postDeliveryFailures },
    plan: plan && { label: 'HHPI 产品实施计划', nodes: plan.nodes.map(({ id, title, depends_on, group }) => ({ id, title, depends_on, group })) } }
}

// Reviewed purpose attribution is separate from live timestamp coverage. Only
// public summary fields enter the page; raw commands and transcripts stay local.
function readWorkAttribution(root, id) {
  let value
  try { value = JSON.parse(readFileSync(resolve(root, 'artifacts/development', basename(id), 'work-attribution.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (value.schemaVersion !== 1 || value.run !== id) return null
  const { title, start, end, scope, measurement, recordCount, commandUnionMs, remaining, evidence } = value
  return { title, start, end, scope, measurement, recordCount, commandUnionMs, remaining, evidence,
    findings: value.findings.map(({ title, detail, evidence }) => ({ title, detail, evidence })),
    agentMeasurement: value.agentMeasurement,
    agents: (value.agents || []).map(({ agent, work, turnMs, reasoningMs, commandMs, observedMs, unattributedMs, usage }) => ({
      agent, work, turnMs, reasoningMs, commandMs, observedMs, unattributedMs,
      usage: usage && { responses: usage.responses, input: usage.input, cached: usage.cached, output: usage.output } })),
    groups: value.groups.map(({ title, count, unionMs, note }) => ({ title, count, unionMs, note })) }
}

const serialized = value => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
export function writeDashboard(store, { output, runId, plan, initial = true }) {
  const destination = resolve(output), snapshot = dashboardSnapshot(store, { runId, plan })
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  const feed = `${destination}.data.js`, temporary = `${feed}.next`
  writeFileSync(temporary, `window.updateProfile(${serialized(snapshot)});\n`, { mode: 0o600 })
  renameSync(temporary, feed)
  if (initial) {
    const template = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8')
    writeFileSync(destination, template.replace('/*__INITIAL__*/', serialized(snapshot)).replace('/*__FEED__*/', serialized(basename(feed))), { mode: 0o600 })
  }
  return { output: destination, feed, run: snapshot.run?.id }
}

export async function watchDashboard(store, options) {
  const interval = options.watchMs
  if (!Number.isFinite(interval) || interval < 1000) throw new Error('Dashboard watch interval must be at least 1000 ms')
  const result = writeDashboard(store, options)
  process.stdout.write(`${JSON.stringify({ ...result, mode: 'watch', intervalMs: interval })}\n`)
  await new Promise((resolve, reject) => {
    let previousVersion = -1, lastWrite = 0
    const cleanup = () => { clearInterval(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop) }
    const stop = () => { cleanup(); resolve() }
    const timer = setInterval(() => {
      try {
        const version = store.db.prepare('PRAGMA data_version').get().data_version
        if (version !== previousVersion || Date.now() - lastWrite >= 30000) {
          writeDashboard(store, { ...options, initial: false }); previousVersion = version; lastWrite = Date.now()
        }
      } catch (error) { cleanup(); reject(error) }
    }, interval)
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
  })
  return result
}
