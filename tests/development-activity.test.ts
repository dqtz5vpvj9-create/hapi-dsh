import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync,writeFileSync,appendFileSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { openStore } from '../scripts/development/store.mjs'
import { startRun,startSpan,finishSpan } from '../scripts/development/profile.mjs'
import { registerSource,syncSource } from '../scripts/development/activity-import.mjs'
import { activityReport,recordState,annotateActivity } from '../scripts/development/activity.mjs'
import { ingestOtel,serveOtel } from '../scripts/development/otel.mjs'
const start=Date.parse('2026-11-07T00:00:00Z')
function fixture(t) {
  const directory=mkdtempSync('/mnt/cache/data-cache/hhpi-activity-'),store=openStore(join(directory,'profile.sqlite'))
  startRun(store,{id:'test',root:directory,now:start})
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true})})
  const file=join(directory,'rollout.jsonl')
  writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'session',cwd:directory}})+'\n')
  return {store,file,directory}
}
const event=(type,payload,ms)=>JSON.stringify({type,timestamp:new Date(start+ms).toISOString(),payload})+'\n'

test('incremental import preserves incomplete UTF8 records, deduplicates replay and ends an open turn',async t=>{
  const {store,file}=fixture(t)
  appendFileSync(file,event('event_msg',{type:'task_started',turn_id:'turn',started_at:start/1000},0))
  const line=event('event_msg',{type:'item_completed',thread_id:'session',turn_id:'turn',item:{id:'cmd',type:'CommandExecution',command:'private command 中文',aggregated_output:'private output'},started_at_ms:start+10,completed_at_ms:start+30},30)
  const bytes=Buffer.from(line),cut=bytes.indexOf(Buffer.from('中文'))+1
  appendFileSync(file,bytes.subarray(0,cut));await registerSource(store,'test',{file})
  await syncSource(store,'test','session',{until:start+1000})
  assert.equal(activityReport(store,'test',{until:start+1000}).rows.length,1)
  appendFileSync(file,bytes.subarray(cut))
  appendFileSync(file,event('event_msg',{type:'task_complete',turn_id:'turn',started_at:start/1000,completed_at:(start+1000)/1000,time_to_first_token_ms:5},1000))
  await syncSource(store,'test','session',{until:start+1000})
  assert.equal((await syncSource(store,'test','session',{until:start+1000})).bytes,0)
  store.db.prepare('UPDATE profile_sources SET cursor=0').run()
  await syncSource(store,'test','session',{until:start+1000})
  const report=activityReport(store,'test',{until:start+1000})
  assert.equal(report.rows.length,3);assert.equal(report.turnUnionMs,1000);assert.equal(report.detailedActivityUnionMs,20)
  assert.equal(report.inTurnUnattributedMs,980)
  assert.ok(!JSON.stringify(report).includes('private'))
})

test('wall-time partition is exhaustive, clips the window and counts overlapping activity once',async t=>{
  const {store,file}=fixture(t);await registerSource(store,'test',{file})
  appendFileSync(file,event('event_msg',{type:'task_complete',turn_id:'turn',started_at:start/1000,completed_at:(start+100)/1000},100))
  appendFileSync(file,event('event_msg',{type:'item_completed',item:{id:'reason',type:'Reasoning'},started_at_ms:start+10,completed_at_ms:start+50},100))
  await syncSource(store,'test','session',{until:start+200})
  const command=startSpan(store,{run:'test',node:null,parent:null,label:'wrapped command',now:start+30});finishSpan(store,command,{status:'passed',now:start+70})
  recordState(store,'test',{at:start+80,state:'paused',evidence:'explicit pause'})
  const report=activityReport(store,'test',{until:start+200})
  assert.deepEqual(report.partition,{activityMs:60,inTurnUnattributedMs:20,pauseMs:120,outsideUnattributedMs:0})
  assert.equal(Object.values(report.partition).reduce((a,b)=>a+b,0),200)
  assert.equal(activityReport(store,'test',{since:start+40,until:start+60}).detailedActivityUnionMs,20)
})

test('owned response usage survives replay and excludes another thread copied into the log',async t=>{
  const {store,file}=fixture(t);await registerSource(store,'test',{file})
  const usage=(thread,id)=>event('token_usage_record',{thread_id:thread,response_id:id,usage:{input_tokens:100,cached_input_tokens:80,output_tokens:20,reasoning_output_tokens:10}},50)
  appendFileSync(file,usage('session','one')+usage('session','one')+usage('other','two'))
  await syncSource(store,'test','session',{until:start+100})
  const u=store.db.prepare('SELECT * FROM usage').get()
  assert.equal(u.input,100);assert.equal(u.output,20)
})

test('OTLP timings stay scoped to registered sessions, discard content and deduplicate retries',async t=>{
  const {store,file}=fixture(t);await registerSource(store,'test',{file})
  const a=(key,stringValue)=>({key,value:{stringValue}})
  const body={resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:String((start+100)*1e6),attributes:[a('conversation.id','session'),a('event.name','codex.api_request'),a('duration_ms','40'),a('prompt','private prompt')]}]}]}]}
  assert.equal(ingestOtel(store,'test',body).imported,1)
  ingestOtel(store,'test',body)
  const report=activityReport(store,'test',{until:start+200})
  assert.equal(report.rows.length,1);assert.equal(report.byKind['api-request'].unionMs,40)
  assert.ok(!JSON.stringify(report).includes('private'))
  const listener=await serveOtel(store,'test',{port:0})
  try {
    const response=await fetch(`http://127.0.0.1:${listener.port}/v1/logs`,{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}})
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{})
    assert.equal(listener.counters.imported,1)
  }finally {listener.server.closeAllConnections();await new Promise(resolve=>listener.server.close(resolve))}
})

test('explicit quota pause cuts background command lifetimes that end after a resume',async t=>{
  const {store,file}=fixture(t);await registerSource(store,'test',{file})
  appendFileSync(file,event('event_msg',{type:'item_completed',item:{id:'background-command',type:'CommandExecution'},started_at_ms:start,completed_at_ms:start+1000},1000))
  await syncSource(store,'test','session',{until:start+1000})
  recordState(store,'test',{at:start+100,state:'paused',evidence:'quota stop'})
  recordState(store,'test',{at:start+900,state:'discussion',evidence:'user resumed discussion'})
  const r=activityReport(store,'test',{until:start+1000})
  assert.deepEqual(r.partition,{activityMs:200,inTurnUnattributedMs:0,pauseMs:800,outsideUnattributedMs:0})
})

test('native Codex zero event time uses its recorded timestamp, not Unix epoch',async t=>{
  const {store,file}=fixture(t);await registerSource(store,'test',{file})
  const attributes=Object.entries({'conversation.id':'session','event.name':'codex.api_request','duration_ms':'40','event.timestamp':new Date(start+100).toISOString()}).map(([key,stringValue])=>({key,value:{stringValue}}))
  ingestOtel(store,'test',{resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:'0',observedTimeUnixNano:String((start+101)*1e6),attributes}]}]}]})
  const r=activityReport(store,'test',{until:start+200});assert.equal(r.byKind['api-request'].unionMs,40);assert.equal(r.rows[0].finished,start+100)
})

test('agent breakdown excludes reviewed servers, preserves unknown time and deduplicates overlapping items',async t=>{
  const {store,file}=fixture(t);await registerSource(store,'test',{file,agent:'child'})
  appendFileSync(file,event('event_msg',{type:'task_complete',turn_id:'turn',started_at:start/1000,completed_at:(start+1000)/1000},1000))
  for(const [id,type,a,b] of [['server','CommandExecution',0,1000],['command','CommandExecution',100,250],['reason','Reasoning',200,400]])
    appendFileSync(file,event('event_msg',{type:'item_completed',item:{id,type},started_at_ms:start+a,completed_at_ms:start+b},1000))
  await syncSource(store,'test','session',{until:start+1000})
  annotateActivity(store,'test',{id:'session:item:server',role:'background',evidence:'reviewed server command'})
  const report=activityReport(store,'test',{until:start+1000}),agent=report.agents[0]
  assert.equal(agent.agent,'child');assert.equal(agent.commandMs,150);assert.equal(agent.reasoningMs,200)
  assert.equal(agent.activityMs,300);assert.equal(agent.backgroundMs,1000);assert.equal(agent.unattributedMs,700)
  assert.equal(report.partition.activityMs,300)
  assert.equal(report.rows.length,4)
  assert.throws(()=>activityReport(store,'test',{since:start+100,until:start+10}),/Invalid/)
})
