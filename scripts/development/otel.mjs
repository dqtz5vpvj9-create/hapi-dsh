import { createServer } from 'node:http'
import { putActivity } from './activity.mjs'
import { transaction } from './store.mjs'

const value = v => v?.stringValue ?? v?.intValue ?? v?.doubleValue ?? v?.boolValue
const attributes = list => Object.fromEntries((list??[]).map(a=>[a.key,value(a.value)]))
const time = ns => Number(ns)/1e6
const sessionId = a => a['conversation.id'] ?? a.conversation_id ?? a['thread.id'] ?? a.thread_id ?? a['session.id'] ?? a.session_id

/** Persist timing and IDs only. Prompts, outputs, errors, arguments and headers are discarded. */
export function ingestOtel(store,run,body) {
  const sessions=new Set(store.db.prepare('SELECT session FROM profile_sources WHERE run=?').all(run).map(s=>s.session))
  let imported=0, ignored=0
  const record=(session,row)=>{
    if(!sessions.has(session)){ignored++;return}
    if(putActivity(store,run,{session,turn:null,...row}))imported++
  }
  transaction(store,()=>{
    for(const resource of body.resourceLogs??[]) for(const scope of resource.scopeLogs??[]) for(const log of scope.logRecords??[]) {
      const a={...attributes(resource.resource?.attributes),...attributes(log.attributes)}
      const event=a['event.name'] ?? a.event_name, session=sessionId(a)
      const finished=time(log.timeUnixNano)>0 ? time(log.timeUnixNano) : Date.parse(a['event.timestamp']) || time(log.observedTimeUnixNano)
      if(!['codex.api_request','codex.sse_event','codex.websocket_request','codex.websocket_event'].includes(event))continue
      const duration=Number(a.duration_ms), kind=event==='codex.api_request'||event==='codex.websocket_request'?'api-request':'stream-event'
      if(!Number.isFinite(duration)||duration<0){ignored++;continue}
      const id=`otel:${session}:${event}:${log.observedTimeUnixNano??log.timeUnixNano}:${a['event.kind']??''}:${log.spanId??''}`
      record(session,{id,kind,label:kind==='api-request'?'Model API request':'Model stream event',started:finished-duration,finished,
        status:a.success===false||Number(a['http.response.status_code'])>=400?'failed':'observed',evidence:`otel:${event}:${log.traceId??''}:${log.spanId??''}`})
      // Only label first-content arrivals when an actual stream event reports the content delta.
      if(['response.output_text.delta','response.reasoning_summary_text.delta'].includes(a.kind??a['event.kind']))
        record(session,{id:`${id}:content`,kind:'stream-content',label:'Stream content arrival',started:finished,finished,status:'observed',evidence:`otel:${event}`})
    }
    for(const resource of body.resourceSpans??[]) for(const scope of resource.scopeSpans??[]) for(const span of scope.spans??[]) {
      const a={...attributes(resource.resource?.attributes),...attributes(span.attributes)}, session=sessionId(a)
      // Whitelist transport/model spans; a whole turn is not model inference.
      if(!/api_request|responses[._ /-](request|stream)|model[._ /-]request|websocket[._ /-]request/u.test(span.name??''))continue
      record(session,{id:`otel-trace:${span.traceId}:${span.spanId}`,kind:'model-transport',label:'Model transport span',
        started:time(span.startTimeUnixNano),finished:time(span.endTimeUnixNano),status:span.status?.code===2?'failed':'observed',
        evidence:`otel-trace:${span.traceId}:${span.spanId}`})
    }
  })
  return {imported,ignored}
}

export async function serveOtel(store,run,{port=4319}={}) {
  const counters={requests:0,imported:0,ignored:0,errors:0}
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(counters));return}
    if(req.method!=='POST'||!['/v1/logs','/v1/traces'].includes(req.url)||req.headers.origin){res.writeHead(404);res.end();return}
    try {
      let size=0;const chunks=[]
      for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024){res.writeHead(413);res.end();return}chunks.push(chunk)}
      const result=ingestOtel(store,run,JSON.parse(Buffer.concat(chunks).toString('utf8')))
      counters.requests++;counters.imported+=result.imported;counters.ignored+=result.ignored
      res.setHeader('Content-Type','application/json');res.end('{}')
    }catch{counters.errors++;res.writeHead(400);res.end('{}')}
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})
  return {server,counters,port:server.address().port}
}
