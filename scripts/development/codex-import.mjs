import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve, sep } from 'node:path'
import { runRecord, transaction } from './store.mjs'

/** Explicit file only: no home-directory scan, raw messages, arguments, results or reasoning copied. */
export async function importCodex(store, runId, file, { node = null, agent = 'root', since, until: requestedUntil } = {}) {
  const run = runRecord(store, runId)
  if (node && !run.dag.nodes.some(n => n.id === node)) throw new Error('Unknown import node')
  const from = since === undefined ? run.started : Date.parse(since)
  if (!Number.isFinite(from) || from < run.started) throw new Error('Import start must be within the run')
  const until = requestedUntil === undefined ? run.finished ?? Date.now() : Date.parse(requestedUntil)
  if (!Number.isFinite(until) || until < from || until > (run.finished ?? Date.now())) throw new Error('Import end must be within the run')
  let session, cwd, line = 0, malformed = 0, beforeUsage, lastUsage, reset = false
  const calls = new Map(), outputs = new Map(), responses = new Map()
  const warnings = []
  for await (const text of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    line++
    let event
    try { event = JSON.parse(text) } catch { malformed++; continue }
    if (event.type === 'session_meta') { session = event.payload?.id; cwd = event.payload?.cwd }
    const at = Date.parse(event.timestamp), payload = event.payload
    if (!payload || !Number.isFinite(at) || at > until) continue
    if (event.type === 'token_usage_record' && payload.response_id && at >= run.started) {
      const usage = payload.usage
      if (usage && ['input_tokens', 'output_tokens', 'cached_input_tokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
        && usage.cached_input_tokens <= usage.input_tokens) responses.set(payload.response_id, usage)
    }
    if (event.type === 'event_msg' && payload.type === 'token_count') {
      const usage = payload.info?.total_token_usage
      if (usage && ['input_tokens', 'output_tokens', 'cached_input_tokens'].every(key => Number.isFinite(usage[key]) && usage[key] >= 0)) {
        if (at >= run.started && lastUsage && ['input_tokens', 'output_tokens', 'cached_input_tokens'].some(key => usage[key] < lastUsage[key])) reset = true
        lastUsage = usage
        if (at < run.started) beforeUsage = usage
      }
    }
    if (at < from || event.type !== 'response_item') continue
    if (['function_call', 'custom_tool_call'].includes(payload.type) && payload.call_id) {
      calls.set(payload.call_id, { name: typeof payload.name === 'string' ? payload.name : 'unknown-tool', at })
    } else if (['function_call_output', 'custom_tool_call_output'].includes(payload.type) && payload.call_id) {
      outputs.set(payload.call_id, at)
    }
  }
  if (!session || typeof session !== 'string' || !cwd || !(resolve(cwd) === run.root || run.root.startsWith(resolve(cwd) + sep))) throw new Error('Rollout must have session metadata matching the run repository or its parent workspace')
  if (malformed) warnings.push(`${malformed} malformed or partial JSONL records were not imported`)
  if (!responses.size && reset) warnings.push('Cumulative usage reset; exact interval token usage is unknown')
  // Without a pre-window counter we cannot separate earlier session usage from this run.
  if (!responses.size && !beforeUsage) warnings.push('No pre-window cumulative counter; interval token usage is unknown')
  if (!responses.size && !lastUsage) warnings.push('No usable token counters')
  const tokens = key => responses.size ? [...responses.values()].reduce((n, u) => n + u[key], 0)
    : !reset && beforeUsage && lastUsage ? lastUsage[key] - beforeUsage[key] : null
  transaction(store, () => {
    const insert = store.db.prepare(`INSERT INTO spans VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET finished=excluded.finished,status=excluded.status`)
    for (const [call, entry] of calls) {
      const end = outputs.get(call)
      insert.run(`codex:${runId}:${session}:${call}`, runId, node, agent, null, 'imported-tool', entry.name,
        entry.at, end !== undefined && end >= entry.at ? end : null, end === undefined ? 'running' : 'observed',
        JSON.stringify({ source: 'codex-rollout', session, call, outcome: 'unknown', attribution: node ? 'explicit-import-window' : 'unassigned' }))
    }
    const previous = store.db.prepare('SELECT finished FROM usage_windows WHERE run=? AND session=?').get(runId, session)
    // Re-read this session from run start; a narrow tool window must not reset its token total.
    if (!previous || until >= previous.finished) {
      store.db.prepare('INSERT INTO usage VALUES(?,?,?,?,?,?) ON CONFLICT(run,session) DO UPDATE SET input=excluded.input,output=excluded.output,cached=excluded.cached,warnings=excluded.warnings')
        .run(runId, session, tokens('input_tokens'), tokens('output_tokens'), tokens('cached_input_tokens'), JSON.stringify(warnings))
      store.db.prepare('INSERT INTO usage_windows VALUES(?,?,?,?,?) ON CONFLICT(run,session) DO UPDATE SET finished=excluded.finished,imported=excluded.imported')
        .run(runId, session, run.started, until, Date.now())
    }
  })
  return { importedCalls: calls.size, from, until, usageFrom: run.started, responses: responses.size, malformed, warnings,
    note: 'Tokens cover run start to until, irrespective of the tool-call window. Returned calls are observed, not classified as successful. No transcript content retained.' }
}
