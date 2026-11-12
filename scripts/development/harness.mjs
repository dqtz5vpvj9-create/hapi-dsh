import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { policyRecord, runRecord } from './store.mjs'
import { taskContext } from './profile.mjs'
import { runCommand } from './runner.mjs'

export function relativeFile(file) {
  if (typeof file !== 'string' || !file || isAbsolute(file) || file.includes('\\') || file.split('/').some(p => p === '..' || p === '.' || !p)) throw new Error('Harness files must be relative, normalized paths')
  return file
}

export function snapshotHarness(manifest, base) {
  if (!manifest) return null
  for (const field of ['files', 'editable']) {
    if (!Array.isArray(manifest[field])) throw new Error('Harness needs files and editable lists')
    manifest[field].forEach(relativeFile)
  }
  const root = resolve(base, manifest.root)
  return { ...manifest, root, contents: Object.fromEntries(manifest.files.map(file => [file, readFileSync(join(root, file), 'utf8')])) }
}

export function materializeHarness(snapshot, document, destination) {
  for (const file of Object.keys(document.harnessFiles || {})) {
    if (!snapshot?.editable.includes(file)) throw new Error(`Policy modifies a file outside the harness scope: ${file}`)
  }
  mkdirSync(destination, { recursive: true })
  for (const [file, body] of Object.entries({ ...snapshot?.contents, ...document.harnessFiles })) {
    mkdirSync(dirname(join(destination, file)), { recursive: true })
    writeFileSync(join(destination, file), body, { mode: 0o600 })
  }
}

export function substitutions(command, values) {
  return command.map(arg => arg.replace(/\{(workspace|harness|policy|context|case|result|suite|suiteDir)\}/g, (_, key) => {
    if (!values[key]) throw new Error(`Missing command input: {${key}}`)
    return values[key]
  }))
}

/** Run the frozen policy in a real workspace; only harness files are copied. */
export async function runHarness(store, { manifestFile, caseFile, ...options }) {
  const run = runRecord(store, options.run), policy = policyRecord(store, run.policy)
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const snapshot = snapshotHarness(manifest, dirname(resolve(manifestFile)))
  const directory = mkdtempSync('/mnt/cache/data-cache/hhpi-harness-')
  try {
    const harness = join(directory, 'harness'), policyFile = join(directory, 'policy.json'), context = join(directory, 'context.json')
    materializeHarness(snapshot, policy.document, harness)
    writeFileSync(policyFile, JSON.stringify(policy.document), { mode: 0o600 })
    writeFileSync(context, JSON.stringify(taskContext(store, run.id, options.node || 'work')), { mode: 0o600 })
    const workspace = resolve(options.cwd || run.root)
    return await runCommand(store, { ...options, cwd: workspace,
      command: substitutions(options.command, { harness, policy: policyFile, context, workspace, case: caseFile && resolve(caseFile) }),
      env: { HHPI_RSI_POLICY: policyFile, HHPI_PROFILE_CONTEXT: context, HHPI_RSI_WORKSPACE: workspace,
        ...(caseFile ? { HHPI_RSI_CASE: resolve(caseFile) } : {}) } })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
