import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { runTypecheck } from '../scripts/development/typecheck.mjs'

const require = createRequire(import.meta.url)
const compilerDirectory = dirname(require.resolve('typescript/package.json'))

// Real installed TypeScript checks tiny isolated projects. Only a dependency's
// public declaration is a fixture; there is no fake compiler or product graph.
function fixture(t) {
  const root = mkdtempSync('/mnt/cache/data-cache/hhpi-typecheck-test-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  put('package.json', JSON.stringify({ type: 'module' }))
  put('package-lock.json', '{}')
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  symlinkSync(compilerDirectory, join(root, 'node_modules/typescript'))
  put('globals.d.ts', 'interface Array<T> { length: number }\ninterface Boolean {}\ninterface Function {}\ninterface CallableFunction {}\ninterface NewableFunction {}\ninterface IArguments {}\ninterface Number {}\ninterface Object {}\ninterface RegExp {}\ninterface String {}\n')
  put('base.json', JSON.stringify({ compilerOptions: { target: 'es2024', module: 'nodenext', strict: true,
    types: [], noLib: true, skipLibCheck: true }, files: ['globals.d.ts'] }))
  for (const name of ['host', 'client']) {
    put(`${name}.json`, JSON.stringify({ extends: './base.json', include: [`${name}/**/*.ts`] }))
    put(`${name}/index.ts`, 'export const value: number = 1\n')
  }
  const options = { root, projects: ['host.json', 'client.json'] }
  return { root, put, options }
}

test('npm typecheck uses the automatic runner and checks unchanged projects only once', async t => {
  const packageFile = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(packageFile.scripts.typecheck, 'node scripts/development/typecheck.mjs')
  const { options } = fixture(t)
  const first = await runTypecheck(options)
  assert.equal(first.exitCode, 0)
  assert.equal(first.executed, 2)
  const unchanged = await runTypecheck(options)
  assert.equal(unchanged.exitCode, 0)
  assert.equal(unchanged.executed, 0)
  assert.ok(unchanged.projects.every(project => project.reused))
})

test('content edits and added included files invalidate only affected projects', async t => {
  const { options, put } = fixture(t)
  await runTypecheck(options)
  put('host/index.ts', 'export const value: number = 2\n')
  const edited = await runTypecheck(options)
  assert.equal(edited.exitCode, 0)
  assert.equal(edited.executed, 1)
  assert.equal(edited.projects[0].incremental, true)
  assert.equal(edited.projects[1].reused, true)
  put('client/new.ts', 'const invalid: number = "added"\n')
  const added = await runTypecheck(options)
  assert.equal(added.exitCode, 1)
  assert.equal(added.executed, 1)
  assert.equal(added.projects[0].reused, true)
  assert.match(added.projects[1].output, /new.ts.*TS2322/)
})

test('dependency corruption, missing declarations and newly available resolution targets invalidate success', async t => {
  const { options, put, root } = fixture(t)
  put('node_modules/example/package.json', JSON.stringify({ name: 'example', types: 'index.d.ts' }))
  put('node_modules/example/index.d.ts', 'export const value: number\n')
  put('host/index.ts', 'import { value } from "example"; const actual: number = value\n')
  assert.equal((await runTypecheck(options)).exitCode, 0)
  put('node_modules/example/index.d.ts', 'export const value: string\n')
  const changed = await runTypecheck(options)
  assert.equal(changed.executed, 1)
  assert.match(changed.projects[0].output, /TS2322/)
  rmSync(join(root, 'node_modules/example/index.d.ts'))
  const missing = await runTypecheck(options)
  assert.match(missing.projects[0].output, /TS2307/)
  put('node_modules/example/index.d.ts', 'export const value: number\n')
  assert.equal((await runTypecheck(options)).exitCode, 0)
  // A new .ts file takes precedence over the declaration for a .js import.
  put('dependency.d.ts', 'export const value: number\n')
  put('host/index.ts', 'import { value } from "../dependency.js"; const actual: number = value\n')
  assert.equal((await runTypecheck(options)).exitCode, 0)
  put('dependency.ts', 'export const value: string = "changed"\n')
  const shadowed = await runTypecheck(options)
  assert.equal(shadowed.exitCode, 1)
  assert.match(shadowed.projects[0].output, /TS2322/)
})

test('all projects return diagnostics and sequential failures never become reusable passes', async t => {
  const { options, put } = fixture(t)
  put('host/index.ts', 'export const host: number = "wrong"\n')
  put('client/index.ts', 'export const client: boolean = 123\n')
  const failed = await runTypecheck(options)
  assert.equal(failed.exitCode, 1)
  assert.equal(failed.executed, 2)
  assert.ok(failed.projects.every(project => /TS2322/.test(project.output)))
  const repeated = await runTypecheck(options)
  assert.equal(repeated.exitCode, 1)
  assert.equal(repeated.executed, 2)
  assert.ok(repeated.projects.every(project => project.incremental))
  put('host/index.ts', 'export const host: number = 1\n')
  put('client/index.ts', 'export const client: boolean = true\n')
  assert.equal((await runTypecheck(options)).exitCode, 0)
  assert.equal((await runTypecheck(options)).executed, 0)
})

test('configuration, lockfile and environment identities invalidate prior results automatically', async t => {
  const { options, put } = fixture(t)
  await runTypecheck(options)
  put('base.json', JSON.stringify({ compilerOptions: { target: 'es2023', module: 'nodenext', types: [], noLib: true }, files: ['globals.d.ts'] }))
  assert.equal((await runTypecheck(options)).executed, 2)
  put('package-lock.json', '{"lockfileVersion":3}')
  const dependencies = await runTypecheck(options)
  assert.equal(dependencies.executed, 2)
  assert.ok(dependencies.projects.every(project => !project.incremental))
  const before = process.env.TSC_TEST_TYPECHECK_ENVIRONMENT
  try {
    process.env.TSC_TEST_TYPECHECK_ENVIRONMENT = 'new-environment'
    assert.equal((await runTypecheck(options)).executed, 2)
  } finally {
    if (before === undefined) delete process.env.TSC_TEST_TYPECHECK_ENVIRONMENT
    else process.env.TSC_TEST_TYPECHECK_ENVIRONMENT = before
  }
})

test('missing or corrupt incremental state causes a real fresh check', async t => {
  const { options } = fixture(t)
  const initial = await runTypecheck(options)
  writeFileSync(initial.projects[0].buildInfo, '{"corrupt":true}')
  const corrupt = await runTypecheck(options)
  assert.equal(corrupt.exitCode, 0)
  assert.equal(corrupt.executed, 1)
  assert.equal(corrupt.projects[0].incremental, false)
  rmSync(corrupt.projects[1].buildInfo)
  const missing = await runTypecheck(options)
  assert.equal(missing.exitCode, 0)
  assert.equal(missing.executed, 1)
  assert.equal(missing.projects[1].incremental, false)
  writeFileSync(missing.projects[0].buildInfo.replace(/\.tsbuildinfo$/, '.json'), '{broken cache manifest')
  const manifest = await runTypecheck(options)
  assert.equal(manifest.exitCode, 0)
  assert.equal(manifest.executed, 1)
  assert.equal(manifest.projects[0].incremental, false)
})

test('an edit to an earlier project while the batch runs cannot publish a stale success', async t => {
  const { options, put } = fixture(t)
  const interrupted = await runTypecheck({ ...options, onProject(result) {
    if (result.project.endsWith('host.json')) put('host/index.ts', 'export const value: number = "changed during check"\n')
  } })
  assert.equal(interrupted.stable, false)
  assert.equal(interrupted.exitCode, 1)
  const current = await runTypecheck(options)
  assert.equal(current.executed, 2)
  assert.equal(current.exitCode, 1)
  assert.match(current.projects[0].output, /TS2322/)
})

for (const failed of [false, true]) {
  test(`concurrent processes share one actual compiler batch (${failed ? 'failure' : 'success'})`, async t => {
    const { options, put } = fixture(t)
    if (failed) put('host/index.ts', 'const invalid: number = "failure"\n')
    let childResult
    let joined = false
    const owner = await runTypecheck({ ...options, onProject: async () => {
      if (joined) return
      joined = true
      let ready
      const waiting = new Promise<void>(resolve => { ready = resolve })
      const source = `import {runTypecheck} from ${JSON.stringify(new URL('../scripts/development/typecheck.mjs', import.meta.url).href)};
        const report=await runTypecheck({...${JSON.stringify(options)},onWait(){console.log('WAITING')}});
        console.log(JSON.stringify({exitCode:report.exitCode,executed:report.executed,coalesced:report.coalesced}));`
      // This helper is a plain ESM process, not another test runner. In the
      // shared-suite mode execArgv includes --test, which conflicts with -e.
      const runtimeFlags = process.execArgv.filter(flag => !/^--test(?:=|-|$)/.test(flag))
      const child = spawn(process.execPath, [...runtimeFlags, '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
      t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
      let output = '', errors = ''
      child.stdout.on('data', data => { output += data; if (output.includes('WAITING')) ready() })
      child.stderr.on('data', data => { errors += data })
      childResult = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', code => code === 0 ? resolve(JSON.parse(output.trim().split('\n').at(-1))) : reject(new Error(errors)))
      })
      await Promise.race([waiting, childResult.then(() => { throw new Error('Compiler follower exited before joining the shared batch') })])
    } })
    const follower = await childResult
    assert.equal(owner.executed, 2)
    assert.equal(follower.executed, 0)
    assert.equal(follower.coalesced, true)
    assert.equal(follower.exitCode, failed ? 1 : 0)
  })
}
