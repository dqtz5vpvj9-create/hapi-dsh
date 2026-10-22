/** Local IPC only. No admission URL or credentials are written to a descriptor file. */
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const warmRepository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const warmDirectory = join(tmpdir(), `hapi-dsh-warm-${createHash('sha256').update(warmRepository).digest('hex').slice(0, 12)}`)
export const warmSocket = join(warmDirectory, 'control.sock')
export type WarmCommand = 'status' | 'check' | 'rebuild-client' | 'restart' | 'reload' | 'stop' | 'connection'

export async function requestWarm<T = unknown>(command: WarmCommand): Promise<T> {
  return await new Promise<T>((resolveRequest, reject) => {
    const req = request({ socketPath: warmSocket, path: `/${command}`, method: 'POST', timeout: 240_000 }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => {
        try {
          const result = JSON.parse(text) as T & { error?: string }
          if (response.statusCode !== 200) reject(new Error(result.error ?? `Warm command failed: ${response.statusCode}`))
          else resolveRequest(result)
        } catch (error) { reject(error) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('Warm fixture command timed out')))
    req.on('error', error => reject((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ECONNREFUSED'
      ? new Error('No warm fixture is running. Start npm run e2e:warm -- serve in another terminal.') : error))
    req.end()
  })
}
