import { open, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { runRecord, transaction } from './store.mjs'
import { putActivity } from './activity.mjs'

const milliseconds = x => typeof x === 'number' ? (x < 100_000_000_000 ? x*1000 : x) : Date.parse(x)
const itemKinds = { CommandExecution:'command', McpToolCall:'mcp-tool', FileChange:'file-change', ImageView:'image-view',
  AgentMessage:'response-item', Reasoning:'reasoning-item', UserMessage:'user-message', SubAgentActivity:'subagent-lifecycle', Extension:'extension' }

export async function registerSource(store, runId, { file, agent = 'root', parent = null }) {
  const run = runRecord(store, runId), absolute = resolve(file), handle = await open(absolute, 'r')
  let metadata
  try {
    const buffer = Buffer.alloc(256*1024), {bytesRead} = await handle.read(buffer,0,buffer.length,0)
    metadata = JSON.parse(buffer.subarray(0,bytesRead).toString().split('\n')[0])
  } finally { await handle.close() }
  const { id, cwd, parent_thread_id, source: origin } = metadata.payload ?? {}
  if (metadata.type !== 'session_meta' || !id || !cwd || !(resolve(cwd)===run.root || run.root.startsWith(resolve(cwd)+sep))) throw new Error('Rollout metadata does not match the run workspace')
  store.db.prepare('INSERT INTO profile_sources(run,session,file,agent,parent) VALUES(?,?,?,?,?) ON CONFLICT(run,session) DO UPDATE SET file=excluded.file,agent=excluded.agent,parent=excluded.parent')
    .run(runId,id,absolute,origin?.subagent?.thread_spawn?.agent_path ?? agent,parent_thread_id ?? origin?.subagent?.thread_spawn?.parent_thread_id ?? parent)
  return { session:id, file:absolute }
}

export function ingestEvent(store, run, source, event, evidence, until) {
  const p=event.payload ?? {}, at=Date.parse(event.timestamp), turn=p.turn_id ?? null
  if (p.thread_id && p.thread_id!==source.session) return null
  const insert = row => {
    if ((row.finished ?? at) < run.started || row.started > until) return
    putActivity(store,run.id,{session:source.session,turn,evidence,...row})
  }
  if (event.type === 'event_msg' && ['task_started','task_complete','turn_aborted'].includes(p.type)) {
    const started=milliseconds(p.started_at ?? at), finished=p.type==='task_started' ? null : milliseconds(p.completed_at ?? at)
    const id=`${source.session}:turn:${turn ?? p.root_turn_id}`
    const previous=store.db.prepare('SELECT started FROM activity_spans WHERE run=? AND id=?').get(run.id,id)
    insert({id,kind:'turn',label:'Agent turn',started:previous?.started ?? started,finished,
      status:p.type==='turn_aborted'?'cancelled':p.error?'failed':finished===null?'running':'completed'})
    if (Number.isFinite(p.time_to_first_token_ms)) insert({id:`${id}:first-token`,kind:'turn-first-token',label:'Turn first token',started:started+p.time_to_first_token_ms,finished:started+p.time_to_first_token_ms,status:'observed'})
  }
  if (event.type === 'event_msg' && p.type === 'item_completed') {
    const item=p.item ?? {}, kind=itemKinds[item.type]
    if (kind && item.id) insert({id:`${source.session}:item:${item.id}`,kind,label:item.type,
      started:Number(p.started_at_ms),finished:Number(p.completed_at_ms),status:item.status ?? 'observed'})
    if (item.type==='SubAgentActivity' && item.agent_thread_id && Number(p.completed_at_ms)>=run.started && Number(p.started_at_ms)<=until)
      return { session:item.agent_thread_id, agent:item.agent_path, parent:source.session }
  }
  if (event.type === 'token_usage_record' && p.response_id && at>=run.started && at<=until) {
    const u=p.usage ?? {}
    if (['input_tokens','cached_input_tokens','output_tokens'].every(k=>Number.isSafeInteger(u[k])&&u[k]>=0) && u.cached_input_tokens<=u.input_tokens)
      store.db.prepare('INSERT OR IGNORE INTO response_usage VALUES(?,?,?,?,?,?,?)').run(run.id,source.session,p.response_id,at,u.input_tokens,u.cached_input_tokens,u.output_tokens)
  }
  return null
}

/** Byte cursor advances only over complete JSONL records; restart and replay are idempotent. */
export async function syncSource(store, runId, session, { until=Date.now() }={}) {
  const run=runRecord(store,runId), source=store.db.prepare('SELECT * FROM profile_sources WHERE run=? AND session=?').get(runId,session)
  if (!source) throw new Error('Register the source before syncing')
  const size=(await stat(source.file)).size
  if (size<source.cursor) throw new Error('Rollout was truncated; preserve the previous source before resetting its cursor')
  const handle=await open(source.file,'r'), children=[], events=[]
  let offset=source.cursor, pending=Buffer.alloc(0), read=source.cursor, malformed=0
  const flush=()=>transaction(store,()=>{
    for (const [event,position] of events) {
      const child=ingestEvent(store,run,source,event,`${source.session}@byte:${position}`,until)
      if (child) children.push(child)
    }
    store.db.prepare('UPDATE profile_sources SET cursor=?,observed=? WHERE run=? AND session=?').run(offset,Date.now(),runId,session)
    events.length=0
  })
  try {
    let done=false
    while(read<size && !done) {
      const buffer=Buffer.alloc(Math.min(256*1024,size-read)), {bytesRead}=await handle.read(buffer,0,buffer.length,read)
      if (!bytesRead) break
      read+=bytesRead;pending=Buffer.concat([pending,buffer.subarray(0,bytesRead)])
      let newline
      while((newline=pending.indexOf(10))>=0) {
        const line=pending.subarray(0,newline).toString('utf8');let event
        try {event=JSON.parse(line)} catch {malformed++}
        if (event && Date.parse(event.timestamp)>until) {done=true;break}
        if (event) events.push([event,offset])
        offset+=newline+1;pending=pending.subarray(newline+1)
        if(events.length>=500) flush()
      }
    }
    flush()
  } finally {await handle.close()}
  const total=store.db.prepare('SELECT count(*) n,sum(input) input,sum(cached) cached,sum(output) output FROM response_usage WHERE run=? AND session=?').get(runId,session)
  const previousWindow=store.db.prepare('SELECT started,finished FROM usage_windows WHERE run=? AND session=?').get(runId,session)
  if(total.n && (!previousWindow || (previousWindow.started===run.started && previousWindow.finished<=until))) transaction(store,()=>{
    store.db.prepare('INSERT INTO usage VALUES(?,?,?,?,?,?) ON CONFLICT(run,session) DO UPDATE SET input=excluded.input,output=excluded.output,cached=excluded.cached,warnings=excluded.warnings')
      .run(runId,session,total.input,total.output,total.cached,'[]')
    store.db.prepare('INSERT INTO usage_windows VALUES(?,?,?,?,?) ON CONFLICT(run,session) DO UPDATE SET finished=max(finished,excluded.finished),imported=excluded.imported')
      .run(runId,session,run.started,until,Date.now())
  })
  return {session,bytes:offset-source.cursor,malformed,children:[...new Map(children.map(c=>[c.session,c])).values()]}
}
