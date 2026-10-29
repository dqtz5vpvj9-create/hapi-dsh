/** Two bounded release captures through the host's fixed webshot utility.
 * Capturing is not visual acceptance. The Agent must inspect the images.
 * The private launch URL and page logs are never written into the report. */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { devNull, homedir } from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('Usage: npm run test:smoke:capture -- --ready-selector CSS [--url-file PATH] [--output DIRECTORY]')
  process.exit(0)
}
const options = { urlFile: path.join(homedir(), '.config/hapi-dsh/launch-url'), output: path.resolve('artifacts/experience-smoke'), selector: '' }
for (let index = 0; index < args.length; index++) {
  const key = { '--url-file': 'urlFile', '--output': 'output', '--ready-selector': 'selector' }[args[index]]
  if (!key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Expected --ready-selector CSS, --url-file PATH, or --output DIRECTORY')
  options[key] = args[++index]
}
if (!options.selector) throw new Error('Specify a visible readiness selector for the surface being reviewed; readiness cannot default to page load.')
const url = new URL((await readFile(options.urlFile, 'utf8')).trim())
if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Release capture requires an HTTP(S) site')
await mkdir(options.output, { recursive: true })
const report = { startedAt: new Date().toISOString(), readiness: { selector: options.selector, meaning: 'selector-visible-only' },
  visualReview: 'required', interactionChecks: 'not-run', captures: [] }
for (const [name, viewport] of [['desktop', '1440x900'], ['mobile', '390x844']]) {
  const output = path.resolve(options.output, `${name}.png`)
  const result = await new Promise((resolve, reject) => {
    const child = spawn('webshot', ['--url', url.href, '--output', output, '--viewport', viewport,
      '--ready-selector', options.selector, '--timeout-ms', '20000', '--log', devNull, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', data => { stdout += data })
    // webshot logs can contain private URLs/content. Keep only structured stage metadata.
    child.stderr.resume()
    child.once('error', () => reject(new Error('webshot could not start; install the fixed webshot utility on this Agent host.')))
    child.once('close', code => {
      let data
      try { data = JSON.parse(stdout.trim()) } catch { /* Missing structured output is a failure. */ }
      resolve({ name, viewport, output, exitCode: code, stage: data?.stage ?? 'unavailable', durationMs: data?.durationMs,
        ready: code === 0 && data?.ok === true && data.stage === 'done', visualReview: 'required' })
    })
  })
  report.captures.push(result)
  console.log(`${name}: ${result.ready ? 'captured; visual review required' : `failed at ${result.stage} (exit ${result.exitCode})`}`)
  if (!result.ready) { process.exitCode = 1; break }
}
await writeFile(path.join(options.output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(`Evidence: ${path.resolve(options.output)}. Screenshots do not verify scrolling, editing, or native execution.`)
