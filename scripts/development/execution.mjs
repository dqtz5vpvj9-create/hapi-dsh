import { decode, runRecord } from './store.mjs'

export const executionInstructions = [
  'Keep ordinary tool failures, retries and debugging output in native process details; handle them as the agent. Present task outcomes, meaningful progress and actionable user problems. Never promote an internal error into a separate user alert solely because a tool failed.',
  'Work on one usable user path per delivery batch; integrate its actual entry point early. Component tasks may finish independently; report delivered paths separately from module progress.',
  'Reuse applicable checks. After two unchanged failures, inspect the failure and change the approach; do not repeat the same build or test hoping for green.',
  'RSI paired evaluations are cancelled by the user. Do not launch baseline/candidate workers or bypass the disabled CLI. Preserve historical results and use observed failures to improve actual delivery work.',
  'Give one agent end-to-end ownership of a usable user path, including composition and focused verification. Do not return every integration edit to root. Root acts on assignment, a cross-path conflict, or completed delivery evidence; otherwise wait for agent events instead of polling, rereading logs, or duplicating implementation review.',
  'Keep deterministic work in scripts. Share one dependency environment per exact lockfile/toolchain and one verified artifact set per source version. Coalesce identical build/typecheck requests, reuse unchanged results and existing outputs, and batch related diagnostics before the next targeted check. Missing outputs or changed inputs invalidate reuse; publication and install side effects are not blindly cached.',
]

export function executionDecision(store, { run, kind, check, inputs, reason, identity }) {
  if (runRecord(store, run).status !== 'running') throw new Error('Run is closed')
  if (!['product-test', 'verification', 'typecheck'].includes(kind) || !check || !inputs) return {}
  // Inputs is an explicit code/environment version supplied by the caller, never a guessed hash.
  const history = store.db.prepare("SELECT id,status,data FROM spans WHERE run=? AND kind=? ORDER BY started DESC,rowid DESC").all(run, kind)
    .filter(s => { const d = decode(s.data); return d.check === check && d.inputs === inputs && d.identity === identity })
  const running = history.find(s => s.status === 'running')
  if (running) return { joined: running.id }
  if (!reason?.trim() && history[0]?.status === 'passed') return { reused: history[0].id }
  if (!reason?.trim() && history.slice(0, 2).length === 2 && history.slice(0, 2).every(s => ['failed', 'timed-out'].includes(s.status))) {
    throw new Error(`Two unchanged failures for ${check}: inspect the cause before rerunning. Use --reason to state what the next attempt will test.`)
  }
  return {}
}
