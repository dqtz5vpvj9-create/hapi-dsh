import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
// @ts-expect-error Node CLI helpers intentionally remain executable JavaScript.
import { collectChangedFiles, selectTests } from '../scripts/test-impact.mjs'
// @ts-expect-error Node CLI helpers intentionally remain executable JavaScript.
import { main, parseOptions, runStage } from '../scripts/test-suite.mjs'

function fixture(t: { after: (callback: () => void) => void }, files: Record<string, string>) {
  const root = mkdtempSync(path.join(existsSync('/mnt/cache/data-cache') ? '/mnt/cache/data-cache' : tmpdir(), 'hapi-test-impact-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (name: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    writeFileSync(path.join(root, name), content)
  }
  for (const [name, content] of Object.entries(files)) write(name, content)
  return { root, write }
}

const files = {
  'src/leaf.ts': 'export const value = 1',
  'src/index.ts': 'export { value } from "./leaf.js"',
  'tests/helper.ts': 'export { value } from "../src/index.js"',
  'tests/leaf.test.ts': 'import { value } from "./helper.js"',
  'tests/other.test.ts': 'import "../src/other.ts"',
  'src/other.ts': 'export const other = 2',
  'tests/experience/leaf.test.tsx': 'import { value } from "../../src/index.js"',
}

test('change selection follows transitive re-exports and .js source mappings into both test layers', t => {
  const { root } = fixture(t, files)
  const result = selectTests(root, ['src/leaf.ts'])
  assert.equal(result.selection, 'affected')
  assert.deepEqual(result.node, ['tests/leaf.test.ts'])
  assert.deepEqual(result.experience, ['tests/experience/leaf.test.tsx'])
})

test('a shared helper selects its consumers and a changed test selects itself', t => {
  const { root } = fixture(t, files)
  assert.deepEqual(selectTests(root, ['tests/helper.ts']).node, ['tests/leaf.test.ts'])
  assert.deepEqual(selectTests(root, ['tests/other.test.ts']).node, ['tests/other.test.ts'])
})

test('esbuild root and relative source literals connect indirect contract tests', t => {
  const { root } = fixture(t, {
    ...files,
    'tests/root.test.ts': 'const entry = join(root, "src/leaf.ts"); await import(`data:text/javascript;base64,${code}`)',
    'tests/relative.test.ts': 'const entry = new URL("../src/leaf.ts", import.meta.url)',
  })
  assert.deepEqual(selectTests(root, ['src/leaf.ts']).node, ['tests/leaf.test.ts', 'tests/relative.test.ts', 'tests/root.test.ts'])
})

test('a removed module imported as .js still selects existing dependent tests', t => {
  const { root } = fixture(t, files)
  rmSync(path.join(root, 'src/leaf.ts'))
  const result = selectTests(root, ['src/leaf.ts'])
  assert.equal(result.selection, 'affected')
  assert.deepEqual(result.node, ['tests/leaf.test.ts'])
  assert.deepEqual(result.experience, ['tests/experience/leaf.test.tsx'])
})

test('unmapped source, removed unmapped files and shared configuration explicitly select all tests', t => {
  const { root } = fixture(t, files)
  for (const changed of ['src/unmapped.ts', 'src/deleted.ts', 'tests/deleted.test.ts', 'tests/fixtures/payload.txt', 'src/prompt.md', 'package-lock.json',
    'package.json', 'tsconfig.client.json', 'vitest.config.ts', 'config/cordis.patch.yml', 'UPSTREAMS.json', 'tests/experience/setup.ts']) {
    const result = selectTests(root, [changed])
    assert.equal(result.selection, 'full', changed)
    assert.deepEqual(result.node, ['tests/leaf.test.ts', 'tests/other.test.ts'], changed)
    assert.deepEqual(result.experience, ['tests/experience/leaf.test.tsx'], changed)
  }
})

test('computed dynamic imports add their test consumers instead of pretending static selection is complete', t => {
  const { root } = fixture(t, { ...files, 'tests/dynamic.test.ts': 'const file = getFile(); await import(file)' })
  const result = selectTests(root, ['src/leaf.ts'])
  assert.deepEqual(result.node, ['tests/dynamic.test.ts', 'tests/leaf.test.ts'])
  assert.match(result.warnings.join(' '), /unresolved dynamic imports/)
})

test('no-change and documentation-only selections explicitly report no execution', t => {
  const { root } = fixture(t, files)
  for (const changed of [[], ['README.md', 'docs/testing.md']]) {
    const result = selectTests(root, changed)
    assert.equal(result.selection, 'none')
    assert.deepEqual(result.node, [])
    assert.deepEqual(result.experience, [])
    assert.match(result.reason, /no tests executed/i)
  }
})

test('Git collection includes staged, unstaged, untracked, deleted and both rename paths', t => {
  const { root, write } = fixture(t, { ...files, 'src/remove.ts': 'export const remove = true' })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline')
  renameSync(path.join(root, 'src/leaf.ts'), path.join(root, 'src/renamed.ts'))
  git('add', 'src/leaf.ts', 'src/renamed.ts')
  write('src/other.ts', 'export const other = 3')
  write('src/new file.ts', 'export const newFile = 1')
  rmSync(path.join(root, 'src/remove.ts'))
  const expected = ['src/leaf.ts', 'src/new file.ts', 'src/other.ts', 'src/remove.ts', 'src/renamed.ts']
  assert.deepEqual(collectChangedFiles(root), expected)
  assert.deepEqual(collectChangedFiles(root, { since: 'HEAD' }), expected)
  assert.deepEqual(collectChangedFiles(root, { files: ['src/leaf.ts'] }), ['src/leaf.ts'])
  assert.throws(() => collectChangedFiles(root, { since: 'not-a-revision' }))
  assert.throws(() => collectChangedFiles(root, { since: '-R' }))
})

test('CLI rejects ambiguous or ineffective filters and invalid time budgets', () => {
  assert.throws(() => parseOptions(['changed', '--files']), /requires/)
  assert.throws(() => parseOptions(['fast', '--files', 'src/a.ts']), /changed mode/)
  assert.throws(() => parseOptions(['changed', '--since', 'HEAD', '--files', 'src/a.ts']), /cannot be combined/)
  assert.throws(() => parseOptions(['full', '--timeout', '0']), /positive/)
  assert.equal(parseOptions(['changed', '--files', 'src/a.ts', 'src/b.ts', '--list']).list, true)
})

test('phase runner records real failures and hard timeouts without retrying', async t => {
  const { root } = fixture(t, {})
  const failed = await runStage('failure', ['-e', 'process.exit(7)'], { root, timeoutMs: 3_000, stdio: 'ignore' })
  assert.equal(failed.exitCode, 7)
  assert.equal(failed.timedOut, false)
  assert.ok(failed.durationMs >= 0)
  const timed = await runStage('timeout', ['-e', 'setInterval(() => {}, 1000)'], { root, timeoutMs: 150, stdio: 'ignore' })
  assert.equal(timed.exitCode, 124)
  assert.equal(timed.timedOut, true)
  assert.ok(timed.durationMs >= 100)
})

test('no-tests JSON report preserves the exact requested path and never claims passed', async t => {
  const { root } = fixture(t, files)
  assert.equal(await main(['changed', '--files', 'README.md', '--report', 'results/no-tests.json'], root), 0)
  const report = JSON.parse(readFileSync(path.join(root, 'results/no-tests.json'), 'utf8'))
  assert.equal(report.status, 'no-tests')
  assert.deepEqual(report.phases, [])
  assert.ok(report.durationMs >= 0)
})

test('compact reporter exposes module loading errors and asynchronous errors outside a test', t => {
  const { root, write } = fixture(t, {})
  const reporter = fileURLToPath(new URL('../scripts/test-suite.mjs', import.meta.url))
  for (const [name, source, message] of [
    ['load.test.mjs', 'throw new Error("fixture load error")', 'fixture load error'],
    ['late.test.mjs', 'import { test } from "node:test"; test("finishes", () => { setImmediate(() => { throw new Error("fixture late error") }) })', 'fixture late error'],
  ]) {
    write(name!, source!)
    const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', `--test-reporter=${reporter}`, name!],
      { cwd: root, encoding: 'utf8', timeout: 5_000 })
    assert.notEqual(result.status, 0)
    assert.ok(`${result.stdout}${result.stderr}`.includes(message!), `${name}: diagnostic missing`)
  }
})
