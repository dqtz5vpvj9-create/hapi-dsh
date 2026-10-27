/**
 * G4 parent: run the original rc.3 composition plus the eight ext feature-switch
 * combinations through the twelve scenarios three times each, then judge the
 * normalized observations with the official ext G4 gate.
 */
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.HAPI_DSH_G4_ROOT ?? '/mnt/cache/src/hapi-dsh/.tmp/g4'
const reportPath = process.env.HAPI_DSH_G4_REPORT ?? '/mnt/cache/src/hapi-dsh/.tmp/gates/g4-artifact.json'
const rounds = Number(process.env.HAPI_DSH_G4_ROUNDS ?? '3')
await mkdir(root, { recursive: true })
const variants: Array<{ variant: string, combo: string }> = [{ variant: 'original', combo: '111' }]
for (let mask = 0; mask < 8; mask++) {
  variants.push({ variant: `ext:${mask & 4 ? 1 : 0}${mask & 2 ? 1 : 0}${mask & 1 ? 1 : 0}`,
    combo: `${mask & 4 ? 1 : 0}${mask & 2 ? 1 : 0}${mask & 1 ? 1 : 0}` })
}
const cases: Array<Record<string, unknown>> = []
for (const { variant, combo } of variants) {
  const out = join(root, `${variant.replace(':', '-')}.json`)
  const ext = variant !== 'original'
  const env: NodeJS.ProcessEnv = { ...process.env, HAPI_DSH_G4_VARIANT: variant, HAPI_DSH_G4_COMBO: combo,
    HAPI_DSH_G4_OUT: out, HAPI_DSH_G4_ROUNDS: String(rounds) }
  if (ext) {
    env.HAPI_DSH_E2E_MANAGED_HOME = process.env.HAPI_DSH_G4_MANAGED_HOME ?? '/mnt/cache/src/hapi-dsh/.tmp/ext-dsh-home'
    env.HAPI_DSH_E2E_MANAGED_PROFILE = process.env.HAPI_DSH_G4_MANAGED_PROFILE ?? 'hapi-ext4'
  } else {
    delete env.HAPI_DSH_E2E_MANAGED_HOME
    delete env.HAPI_DSH_E2E_MANAGED_PROFILE
  }
  const started = Date.now()
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'e2e/g4-run-one.ts'], { cwd: '/mnt/cache/src/hapi-dsh',
    env, encoding: 'utf8', timeout: 60 * 60_000 })
  console.error(`[g4] ${variant} combo=${combo} exit=${result.status} in ${Math.round((Date.now() - started) / 1000)}s ${result.stdout.trim().slice(-200)}`)
  if (result.status !== 0) { console.error(result.stderr.slice(-1200)); continue }
  const payload = JSON.parse(await readFile(out, 'utf8')) as { cases: Array<Record<string, unknown>> }
  cases.push(...payload.cases)
}
const dataset = { schema: 1, gate: 'G4', environment: 'original rc.3 and ext feature-switch combinations in the warm synthetic fixture',
  cases }
await writeFile(reportPath, JSON.stringify(dataset, null, 1))
console.log(JSON.stringify({ cases: cases.length, expected: 9 * 12 * rounds,
  variants: [...new Set(cases.map(entry => entry.variant))].length }, null, 1))
