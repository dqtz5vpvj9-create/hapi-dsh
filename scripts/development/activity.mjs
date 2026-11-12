import { runRecord } from './store.mjs'

export function putActivity(store, run, row) {
  if (!Number.isFinite(row.started) || (row.finished !== null && (!Number.isFinite(row.finished) || row.finished < row.started))) return false
  store.db.prepare(`INSERT INTO activity_spans VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run,id) DO UPDATE SET
    started=min(started,excluded.started),finished=coalesce(excluded.finished,finished),status=CASE WHEN excluded.finished IS NULL AND finished IS NOT NULL THEN status ELSE excluded.status END,evidence=excluded.evidence`)
    .run(run, row.id, row.session, row.turn ?? null, row.kind, row.label, row.started, row.finished, row.status, row.evidence)
  return true
}

export function recordState(store, run, { at = Date.now(), state, evidence }) {
  const record = runRecord(store, run)
  if (!['development', 'discussion', 'paused'].includes(state) || !evidence?.trim()) throw new Error('State requires development|discussion|paused and an evidence locator')
  if (!Number.isFinite(at) || at < record.started || at > Date.now()) throw new Error('State timestamp must be within the recorded period')
  store.db.prepare('INSERT INTO recording_states VALUES(?,?,?,?) ON CONFLICT(run,at) DO UPDATE SET state=excluded.state,evidence=excluded.evidence').run(run, at, state, evidence)
}

/** Reviewed process ownership, never inferred from a long duration alone. */
export function annotateActivity(store, run, { id, role, evidence }) {
  if (!['work', 'background', 'wait'].includes(role) || !evidence?.trim()) throw new Error('Activity annotation requires work|background|wait and evidence')
  if (!store.db.prepare('SELECT 1 FROM activity_spans WHERE run=? AND id=?').get(run, id)) throw new Error('Unknown recorded activity')
  store.db.prepare('INSERT INTO activity_annotations VALUES(?,?,?,?) ON CONFLICT(run,id) DO UPDATE SET role=excluded.role,evidence=excluded.evidence').run(run,id,role,evidence)
}

export function merged(intervals) {
  const result = []
  for (const [a, b] of intervals.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1)
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else result.push([a, b])
  }
  return result
}
const duration = intervals => merged(intervals).reduce((n, [a, b]) => n + b - a, 0)
function subtract(outer, inner) {
  const result = [], inside = merged(inner)
  for (const [a, b] of merged(outer)) {
    let cursor = a
    for (const [x, y] of inside) {
      if (y <= cursor) continue
      if (x >= b) break
      if (x > cursor) result.push([cursor, Math.min(x, b)])
      cursor = Math.max(cursor, y)
      if (cursor >= b) break
    }
    if (cursor < b) result.push([cursor, b])
  }
  return result
}

export function activityReport(store, runId, { until = Date.now(), since } = {}) {
  const run = runRecord(store, runId), start = Math.max(run.started, since ?? run.started), end = Math.min(run.finished ?? until, until)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Invalid activity time window')
  const sources = store.db.prepare('SELECT session,agent,parent,observed FROM profile_sources WHERE run=?').all(runId)
  const rows = store.db.prepare(`SELECT a.*,coalesce(n.role,'work') role,n.evidence roleEvidence FROM activity_spans a
    LEFT JOIN activity_annotations n ON n.run=a.run AND n.id=a.id
    WHERE a.run=? AND a.started<=? AND (a.finished IS NULL OR a.finished>=?) ORDER BY a.started,a.id`).all(runId, end, start)
  const clips = list => list.filter(r => r.finished !== null).map(r => [Math.max(start, r.started), Math.min(end, r.finished)]).filter(([a,b]) => b >= a)
  const commands = store.db.prepare("SELECT agent,kind,started,finished FROM spans WHERE run=? AND kind NOT IN ('task','background','wait') AND finished IS NOT NULL").all(runId)
  const detail = rows.filter(r => r.role === 'work' && !['turn', 'turn-first-token', 'subagent-lifecycle', 'user-message'].includes(r.kind))
  const phases = store.db.prepare('SELECT * FROM recording_states WHERE run=? AND at<=? ORDER BY at').all(runId, end)
  const phaseIntervals = phases.map((p, i) => ({ ...p, interval: [Math.max(start, p.at), Math.min(end, phases[i+1]?.at ?? end)] }))
  // Item/command lifetimes can remain open through a quota stop (for example
  // a background server). A documented execution pause is not development
  // activity; preserve the original rows, but cut the pause out of coverage.
  const paused = merged(phaseIntervals.filter(p => p.state === 'paused').map(p => p.interval))
  const commandIntervals = subtract(clips(commands),paused)
  const details = subtract(clips(detail),paused), turns = subtract(clips(rows.filter(r => r.kind === 'turn')),paused)
  const activity = merged([...commandIntervals,...details]), envelopes=merged([...activity,...turns])
  const unknown = subtract([[start, end]], [...envelopes, ...paused])
  const unattributedInTurns = subtract(turns, activity)
  const byKind = {}
  for (const kind of new Set(detail.map(r => r.kind))) {
    const list = clips(detail.filter(r => r.kind === kind)).flatMap(interval => subtract([interval],paused))
    byKind[kind] = { count: clips(detail.filter(r => r.kind === kind)).length, unionMs: duration(list), inclusiveMs: list.reduce((n,[a,b])=>n+b-a,0) }
  }
  return { start, end, spanMs: end-start, commandUnionMs: duration(commandIntervals), detailedActivityUnionMs: duration(activity),
    additionalActivityMs: duration(subtract(details, commandIntervals)), turnUnionMs: duration(turns),
    inTurnUnattributedMs: duration(unattributedInTurns), explicitPauseMs: duration(paused), outsideUnattributedMs: duration(unknown),
    accountedEnvelopeMs: duration(envelopes), remainingUnattributedMs: duration(unattributedInTurns)+duration(unknown),
    // Four disjoint buckets partition wall time. Turn envelopes are NOT model inference.
    partition: { activityMs: duration(activity), inTurnUnattributedMs: duration(unattributedInTurns), pauseMs: duration(paused), outsideUnattributedMs: duration(unknown) },
    gaps: [...unattributedInTurns.map(([started,finished])=>({started,finished,kind:'in-turn-unknown'})), ...unknown.map(([started,finished])=>({started,finished,kind:'outside-unknown'}))].sort((a,b)=>b.finished-b.started-(a.finished-a.started)).slice(0,30),
    phases: phaseIntervals.map(({interval,...p})=>({...p,started:interval[0],finished:interval[1]})), sources, byKind,
    agents: sources.map(s=>{
      const own = rows.filter(r=>r.session===s.session), recorded = detail.filter(r=>r.session===s.session)
      const windows = subtract(clips(own.filter(r=>r.kind==='turn')),paused)
      const reasoning = subtract(clips(recorded.filter(r=>r.kind==='reasoning-item')),paused)
      const command = subtract(clips(recorded.filter(r=>r.kind==='command')),paused)
      const observed = subtract(clips(recorded),paused)
      const usage = store.db.prepare('SELECT count(*) responses,coalesce(sum(input),0) input,coalesce(sum(cached),0) cached,coalesce(sum(output),0) output FROM response_usage WHERE run=? AND session=? AND at>=? AND at<=?').get(runId,s.session,start,end)
      return {agent:s.agent,parent:s.parent,session:s.session,turnWindows:windows,turnMs:duration(windows),
        reasoningMs:duration(reasoning),commandMs:duration(command),activityMs:duration(observed),
        backgroundMs:duration(subtract(clips(own.filter(r=>r.role==='background')),paused)),
        waitMs:duration(subtract(clips(own.filter(r=>r.role==='wait')),paused)),
        unattributedMs:duration(subtract(windows,observed)),unfinished:own.filter(r=>r.finished===null).length,usage}
    }),
    rows: rows.map(({run,...r})=>({...r,agent:sources.find(s=>s.session===r.session)?.agent ?? r.session})),
    meaning: 'Item timestamps measure recorded item lifetimes. Turn envelopes include runtime gaps; they are not inference durations. Pauses require explicit evidence. Concurrent intervals are unioned.' }
}
