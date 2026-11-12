import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { registerSource, syncSource } from './activity-import.mjs'
import { serveOtel } from './otel.mjs'
import { writeDashboard } from './dashboard.mjs'

async function rolloutIndex(directory) {
  const files=await readdir(directory,{recursive:true})
  return files.filter(f=>f.endsWith('.jsonl')&&f.split('/').at(-1).startsWith('rollout-')).map(f=>join(directory,f))
}

export async function collect(store,{run,sourcesFile,once=false,port=4319,intervalMs=2000,until=Date.now(),dashboard,plan}) {
  if(!Number.isFinite(until)||!Number.isFinite(intervalMs)||intervalMs<250)throw new Error('Invalid collection time or interval')
  const manifest=JSON.parse(await readFile(sourcesFile,'utf8'))
  for(const source of manifest.sources) await registerSource(store,run,source)
  let index, lastError=null, passes=0, initial=true, lastRendered=0, version
  const sync=async()=>{
    const pending=store.db.prepare('SELECT session FROM profile_sources WHERE run=?').all(run), done=new Set(), results=[]
    for(const source of pending) {
      if(done.has(source.session))continue
      done.add(source.session)
      const result=await syncSource(store,run,source.session,{until:once?until:Date.now()});results.push(result)
      for(const child of result.children) {
        if(store.db.prepare('SELECT 1 FROM profile_sources WHERE run=? AND session=?').get(run,child.session))continue
        index??=await rolloutIndex(manifest.sessionsDirectory)
        let file=index.find(f=>f.endsWith(`-${child.session}.jsonl`))
        if(!file){index=await rolloutIndex(manifest.sessionsDirectory);file=index.find(f=>f.endsWith(`-${child.session}.jsonl`))}
        if(file){await registerSource(store,run,{...child,file});pending.push(child)}
      }
    }
    const nextVersion=store.db.prepare('PRAGMA data_version').get().data_version
    // Cursors still advance every pass. Rebuild the report only on new evidence
    // or the existing 30-second heartbeat, rather than rereading all history.
    if(dashboard && (initial || results.some(r=>r.bytes>0) || nextVersion!==version || Date.now()-lastRendered>=30_000)) {
      writeDashboard(store,{output:dashboard,runId:run,plan,initial});initial=false;lastRendered=Date.now()
    }
    version=nextVersion
    passes++;return results
  }
  if(once)return {sources:await sync()}
  const listener=await serveOtel(store,run,{port})
  console.log(JSON.stringify({collector:'listening',port:listener.port,run}))
  let stopped=false, wake
  const stop=()=>{stopped=true;wake?.()}
  process.once('SIGINT',stop);process.once('SIGTERM',stop)
  try {
    while(!stopped) {
      try{await sync();lastError=null}catch(error){lastError=error.message;console.error(`Profile collection: ${lastError}`)}
      if(!stopped)await new Promise(resolve=>{const timer=setTimeout(resolve,intervalMs);wake=()=>{clearTimeout(timer);resolve()}})
    }
  } finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);await new Promise(resolve=>listener.server.close(resolve))}
  return {passes,lastError,...listener.counters}
}
