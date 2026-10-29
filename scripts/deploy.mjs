/** Production release entry point. Never restarts HAPI or an original Runner. */
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import WebSocket from 'ws'

const host = process.argv.includes('--host')
if (process.argv.slice(2).some(arg => arg !== '--host')) throw new Error('Usage: npm run deploy [-- --host]')
process.chdir(fileURLToPath(new URL('..', import.meta.url)))
const run = (command, args) => {
    const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, TMPDIR: '/mnt/cache/data-cache' } })
    if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.message})`)
}
run('npm', ['run', 'typecheck'])
run('npm', ['test'])
run('npm', ['run', 'test:faults'])
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
let clientMismatch
const localClient = host ? undefined : await readFile('dist/client.js')
for (let attempt = 0; attempt < 45; attempt++) {
    try {
        const page = await fetch(launch.origin, { headers, signal: AbortSignal.timeout(5_000) })
        await page.arrayBuffer()
        const bootstrap = await fetch(new URL('/hapi-dsh/bootstrap', launch), { headers, signal: AbortSignal.timeout(5_000) })
        const graph = bootstrap.ok ? (await bootstrap.json()).graph : undefined
        const entry = graph?.entries?.find(entry => entry.id === 'hapi-dsh')
        const asset = entry?.url
        if (page.ok && typeof asset === 'string') {
            const bundle = await fetch(new URL(asset, launch), { headers, signal: AbortSignal.timeout(5_000) })
            if (bundle.ok) {
                const served = Buffer.from(await bundle.arrayBuffer())
                // The official route appends a revisioned source-map trailer;
                // its executable prefix must still be the completed workspace
                // bundle before the history smoke is allowed to claim release.
                if (localClient && !served.subarray(0, localClient.length).equals(localClient)) {
                    clientMismatch = entry.rev
                    break
                }
                ready = true
                break
            }
        }
    } catch { /* The display Host may still be starting. */ }
    if (clientMismatch) break
    if (attempt % 5 === 0) process.stdout.write('Waiting for the display Host HTTP endpoint…\n')
    await new Promise(resolve => setTimeout(resolve, 2_000))
}
if (clientMismatch) throw new Error(`Client-only build did not reach the active HAPI-DSh release (live graph revision ${clientMismatch}); the smoke would otherwise test a stale client`)
if (!ready) throw new Error('Build finished, but the HTTP endpoint did not become ready; inspect the service log')
// HTTP readiness cannot detect an authority-bound cookie lost by a WS proxy.
// Exercise the public TLS route with the same admitted cookie, without opening
// any logical Session stream or dispatching an operation.
await new Promise((resolve, reject) => {
    const url = new URL('/hapi-dsh/remote.mux', launch); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, { headers: { ...headers, origin: launch.origin }, handshakeTimeout: 10_000 })
    socket.once('error', reject)
    socket.once('open', () => {
        const compressed = socket.extensions.includes('permessage-deflate')
        socket.close()
        if (compressed) resolve(); else reject(new Error('The public Session stream did not negotiate compression'))
    })
})
run('npm', ['run', 'test:smoke:history'])
process.stdout.write(`Published ${host ? 'Host and client' : 'client without restarting the Host'}. Authenticated HTTP, compressed WebSocket and continuous history reading passed; screenshot and physical device acceptance are reported separately.\n`)
