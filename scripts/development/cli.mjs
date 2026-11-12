#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openStore, policyRecord } from './store.mjs'
import { initializePolicy, startRun, transitionTask, assignTask, readyTasks, recordGate, recordProgress, observe, profileReport, finishRun, taskContext } from './profile.mjs'
import { runCommand } from './runner.mjs'
import { runHarness } from './harness.mjs'
import { importCodex } from './codex-import.mjs'
import { writeReport } from './report.mjs'
import { collect } from './collect.mjs'
import { recordState, activityReport, annotateActivity } from './activity.mjs'
import { writeDashboard, watchDashboard } from './dashboard.mjs'
import { proposePolicy, improvementBrief, promotePolicy, rollbackPolicy } from './rsi.mjs'

const help = `Development harness profile and RSI
  profile start [--id ID] [--root DIR] [--dag JSON] [--checks JSON] [--policy ID]
  profile task --run ID --node NODE --state ready|running|blocked|done|cancelled [--agent ID] [--reason TEXT] [--evidence LOCATOR]
  profile progress --run ID --title TITLE --summary TEXT --status working|waiting|blocked|pending-release|released|completed --evidence LOCATOR [--node NODE] [--agent ID]
  profile task --run ID --node NODE --assign AGENT --agent root --reason TEXT
  profile next --run ID
  profile context --run ID --node NODE
  profile gate --run ID --name NAME --evidence LOCATOR
  profile run --run ID [--node NODE] --label LABEL [--kind product-test|typecheck|install|generate|build|investigation|command] [--check ID --inputs VERSION] [--reason TEXT] [--timeout MS] [--harness MANIFEST --case JSON] -- COMMAND ARG...
  profile observe --run ID --requirement ID --layer LAYER --status passed|failed|unknown --evidence LOCATOR [--by agent|independent-review|user]
  profile import-codex --run ID --file JSONL [--node NODE] [--agent ID] [--since ISO] [--until ISO]
  profile collect --run ID --sources JSON [--once yes] [--until ISO] [--port 4319] [--interval 2000] [--dashboard HTML] [--plan JSON]
  profile state --run ID --state development|discussion|paused --evidence LOCATOR [--at ISO]
  profile activity --run ID [--since ISO --until ISO] [--output PATH.json]
  profile annotate --run ID --activity ID --role work|background|wait --evidence LOCATOR
  profile report --run ID [--output PATH.json|PATH.html]
  profile dashboard --output PATH.html [--run ID] [--plan JSON] [--watch-ms 2000]
  profile finish --run ID --status completed|incomplete|cancelled
  rsi policy [--id ID]
  rsi brief --run ID
  rsi propose --policy-file JSON --hypothesis TEXT --evidence-run ID [--id ID] [--parent ID]
  rsi evaluate (cancelled by user; does not start workers)
  rsi promote --evaluation ID
  rsi rollback --reason TEXT
All commands accept --db PATH; default artifacts/development/profile.sqlite (local, ignored).
Profiles store metadata and explicit evidence locators. Keep labels and evidence free of secrets.
RSI paired evaluations are cancelled. Historical evaluations remain readable.
`

function options(args) {
  const split = args.indexOf('--'), values = {}, positional = split < 0 ? args : args.slice(0, split)
  for (let index = 0; index < positional.length; index += 2) {
    const key = positional[index], value = positional[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || key in values) throw new Error(`Expected --option VALUE: ${key}`)
    values[key] = value
  }
  return { values, command: split < 0 ? [] : args.slice(split + 1) }
}

export async function main(args = process.argv.slice(2)) {
  const separator = args.indexOf('--')
  if (!args.length || args.slice(0, separator < 0 ? args.length : separator).includes('--help')) { process.stdout.write(help); return 0 }
  const [group, action, ...rest] = args
  const { values: o, command } = options(rest)
  const opt = key => o[`--${key}`]
  const need = key => { const value = opt(key); if (!value) throw new Error(`--${key} is required`); return value }
  const json = key => { const file = opt(key); return file ? JSON.parse(readFileSync(file, 'utf8')) : undefined }
  const lists = {
    'profile/start': ['id', 'root', 'dag', 'checks', 'policy'],
    'profile/task': ['run', 'node', 'state', 'assign', 'agent', 'reason', 'evidence'], 'profile/next': ['run'],
    'profile/progress': ['run', 'node', 'title', 'summary', 'status', 'evidence', 'agent'],
    'profile/context': ['run', 'node'], 'profile/gate': ['run', 'name', 'evidence'],
    'profile/run': ['run', 'node', 'agent', 'kind', 'label', 'timeout', 'cwd', 'harness', 'case', 'check', 'inputs', 'reason'],
    'profile/observe': ['run', 'requirement', 'layer', 'status', 'evidence', 'by'],
    'profile/import-codex': ['run', 'file', 'node', 'agent', 'since', 'until'], 'profile/report': ['run', 'output'],
    'profile/collect': ['run', 'sources', 'once', 'until', 'port', 'interval', 'dashboard', 'plan'],
    'profile/state': ['run', 'state', 'at', 'evidence'],
    'profile/activity': ['run', 'since', 'until', 'output'],
    'profile/annotate': ['run', 'activity', 'role', 'evidence'],
    'profile/finish': ['run', 'status'], 'rsi/policy': ['id'], 'rsi/brief': ['run'],
    'profile/dashboard': ['output', 'run', 'plan', 'watch-ms'],
    'rsi/propose': ['id', 'parent', 'policy-file', 'hypothesis', 'evidence-run'],
    'rsi/evaluate': ['candidate', 'suite'], 'rsi/promote': ['evaluation'], 'rsi/rollback': ['reason'],
  }
  const key = `${group}/${action}`, allowed = lists[key]
  if (!allowed) throw new Error(`Unknown command: ${key}; use --help`)
  for (const option of Object.keys(o)) if (option !== '--db' && !allowed.includes(option.slice(2))) throw new Error(`Unknown option: ${option}`)
  if (command.length && key !== 'profile/run') throw new Error('Only profile run accepts a command after --')
  if (key === 'rsi/evaluate') throw new Error('RSI paired evaluations were cancelled by the user. No workers started; retain profile evidence and improve the actual delivery workflow.')
  const store = openStore(o['--db'])
  let result, exitCode = 0
  try {
    switch (key) {
      case 'profile/start': result = startRun(store, { id: opt('id'), root: opt('root'), dag: json('dag'), checks: json('checks'), policy: opt('policy') }); break
      case 'profile/task':
        if (opt('assign') !== undefined) {
          if (opt('state') !== undefined) throw new Error('--assign and --state are separate actions')
          result = assignTask(store, need('run'), need('node'), need('assign'), { agent: need('agent'), reason: need('reason') })
        } else result = transitionTask(store, need('run'), need('node'), need('state'), { agent: opt('agent'), reason: opt('reason'), evidence: opt('evidence') })
        break
      case 'profile/progress': result = recordProgress(store, need('run'), { title: need('title'), summary: need('summary'), status: need('status'), evidence: need('evidence'), node: opt('node'), agent: opt('agent') }); break
      case 'profile/next': result = readyTasks(store, need('run')); break
      case 'profile/context': result = taskContext(store, need('run'), need('node')); break
      case 'profile/gate': recordGate(store, need('run'), need('name'), need('evidence')); result = { recorded: true }; break
      case 'profile/run': {
        if (opt('case') && !opt('harness')) throw new Error('--case requires --harness')
        const execute = opt('harness') ? runHarness : runCommand
        result = await execute(store, { run: need('run'), node: opt('node'), agent: opt('agent'), kind: opt('kind'), label: need('label'),
          manifestFile: opt('harness'), caseFile: opt('case'), command, cwd: opt('cwd'), check: opt('check'), inputs: opt('inputs'), reason: opt('reason'), timeoutMs: opt('timeout') === undefined ? undefined : Number(opt('timeout')) })
        exitCode = result.exitCode; break
      }
      case 'profile/observe': result = { observation: observe(store, need('run'), { requirement: need('requirement'), layer: need('layer'),
        status: need('status'), evidence: opt('evidence'), discoveredBy: opt('by') }) }; break
      case 'profile/import-codex': result = await importCodex(store, need('run'), need('file'), { node: opt('node'), agent: opt('agent'), since: opt('since'), until: opt('until') }); break
      case 'profile/collect': result=await collect(store,{run:need('run'),sourcesFile:need('sources'),once:opt('once')==='yes',until:opt('until')?Date.parse(opt('until')):undefined,
        port:opt('port')===undefined?undefined:Number(opt('port')),intervalMs:opt('interval')===undefined?undefined:Number(opt('interval')),dashboard:opt('dashboard'),plan:json('plan')});break
      case 'profile/state': recordState(store,need('run'),{state:need('state'),at:opt('at')?Date.parse(opt('at')):undefined,evidence:need('evidence')});result={recorded:true};break
      case 'profile/annotate': annotateActivity(store,need('run'),{id:need('activity'),role:need('role'),evidence:need('evidence')});result={recorded:true};break
      case 'profile/activity': {
        const report=activityReport(store,need('run'),{since:opt('since')?Date.parse(opt('since')):undefined,until:opt('until')?Date.parse(opt('until')):undefined})
        const {start,end,agents,partition,meaning}=report
        result={start,end,agents,partition,meaning}
        if(opt('output')) {writeFileSync(resolve(opt('output')),JSON.stringify(result,null,2)+'\n',{mode:0o600});result={output:resolve(opt('output'))}}
        break
      }
      case 'profile/report': {
        result = profileReport(store, need('run'))
        const output = opt('output')
        if (output) { writeReport(result, resolve(output)); result = { output: resolve(output), issues: result.issues.length, status: result.run.status } }
        break
      }
      case 'profile/finish': finishRun(store, need('run'), need('status')); result = { closed: true }; break
      case 'profile/dashboard': {
        const options = { output: need('output'), runId: opt('run'), plan: json('plan'), watchMs: Number(opt('watch-ms')) }
        result = opt('watch-ms') === undefined ? writeDashboard(store, options) : await watchDashboard(store, options)
        break
      }
      case 'rsi/policy': initializePolicy(store); result = policyRecord(store, opt('id')); break
      case 'rsi/brief': result = improvementBrief(store, need('run')); break
      case 'rsi/propose': result = proposePolicy(store, { id: opt('id'), parent: opt('parent'), document: json('policy-file'), hypothesis: need('hypothesis'), evidenceRun: need('evidence-run') }); break
      case 'rsi/promote': result = promotePolicy(store, need('evaluation')); break
      case 'rsi/rollback': result = rollbackPolicy(store, need('reason')); break
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return exitCode
  } finally { store.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code }, error => { console.error(error.message); process.exitCode = 1 })
}
