/** Production release entry point. Never restarts HAPI or an original Runner. */
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const host = process.argv.includes('--host')
if (process.argv.slice(2).some(arg => arg !== '--host')) throw new Error('Usage: npm run deploy [-- --host]')
process.chdir(fileURLToPath(new URL('..', import.meta.url)))
const run = (command, args) => {
    const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, TMPDIR: '/mnt/cache/data-cache' } })
    if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.message})`)
}
run('npm', ['run', 'typecheck'])
run('npm', ['test'])
// The launch credential stays in memory and is never logged.
const launch = new URL((await readFile(`${homedir()}/.config/hapi-dsh/launch-url`, 'utf8')).trim())
const auth = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
const headers = { cookie: auth.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ') }
const assertIdle = async () => {
    const response = await fetch(new URL('/api/session/list', launch), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'deploy-idle-check', method: 'session/list', payload: { args: { _request: {} } } }), signal: AbortSignal.timeout(20_000) })
    const payload = await response.json()
    if (!response.ok || !payload.result?.ok) throw new Error('Cannot check the display Host before restart')
    const running = payload.result.value.items.filter(row => row.running && !row.sessionId.startsWith('hapi-'))
    if (running.length) throw new Error(`${running.length} ordinary DSH sessions are running; the Host was not restarted`)
}
run('npm', ['run', host ? 'build' : 'build:client'])
if (host) { await assertIdle(); run('systemctl', ['--user', 'restart', 'hapi-dsh-host.service']) }
let ready = false
for (let attempt = 0; attempt < 45; attempt++) {
    try {
        const page = await fetch(launch.origin, { headers, signal: AbortSignal.timeout(5_000) })
        const html = await page.text()
        const asset = [...html.matchAll(/(?:href|src)="([^"]*hapi-dsh\/client\.js[^"]*)"/g)][0]?.[1]?.replaceAll('&amp;', '&')
        if (page.ok && asset) {
            const bundle = await fetch(new URL(asset, launch), { headers, signal: AbortSignal.timeout(5_000) })
            if (bundle.ok) { await bundle.arrayBuffer(); ready = true; break }
        }
    } catch { /* The display Host may still be starting. */ }
    if (attempt % 5 === 0) process.stdout.write('Waiting for the display Host HTTP endpoint…\n')
    await new Promise(resolve => setTimeout(resolve, 2_000))
}
if (!ready) throw new Error('Build finished, but the HTTP endpoint did not become ready; inspect the service log')
process.stdout.write(`Published ${host ? 'Host and client' : 'client without restarting the Host'}. HTTP ready; UI acceptance belongs to the user.\n`)
