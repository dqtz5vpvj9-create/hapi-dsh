/** Test-only module carrier. Official client scripts and factory bytes stay unchanged. */
import { modules } from 'hhpi-platform'

type Factory = { factory(require: ((id: string) => unknown) & { async(id: string): Promise<unknown> }): unknown }
const factories = new Map<string, Factory>(), instances = new Map<string, unknown>()
let loading: string | undefined
const canonical = (id: string): string => id.replace(/\/client$/, '')
const carrier = window as unknown as { __ModuleLoader__: { load(value: Factory): void }; __HHPI_REQUIRE__: (id: string) => unknown; __hhpiFailure?: string }
carrier.__ModuleLoader__ = { load(value) {
  if (!loading || factories.has(loading)) throw new Error('Unexpected or duplicate official module registration')
  factories.set(loading, value)
} }
function requireOfficial(id: string): unknown {
  if (Object.hasOwn(modules, id)) return modules[id as keyof typeof modules]
  const key = canonical(id)
  if (instances.has(key)) return instances.get(key)
  const entry = factories.get(key)
  if (!entry) throw new Error(`Missing real browser dependency: ${id}`)
  const scoped = Object.assign((request: string) => requireOfficial(request), { async: async (request: string) => {
    if (!request.startsWith('./client.') || !request.endsWith('.js')) return requireOfficial(request)
    const chunk = `${key}/${request.slice(2)}`
    if (!factories.has(chunk)) await load(chunk, `/official/${key.split('/')[1]}/${request.slice(2)}`)
    return requireOfficial(chunk)
  } })
  const value = entry.factory(scoped)
  instances.set(key, value)
  return value
}
async function load(key: string, url: string): Promise<void> {
  loading = key
  try {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = url; script.onload = () => resolve(); script.onerror = () => reject(new Error(`Official bundle failed: ${key}`))
      document.head.appendChild(script)
    })
    if (!factories.has(key)) throw new Error(`Official bundle did not register: ${key}`)
  } finally { loading = undefined }
}
carrier.__HHPI_REQUIRE__ = requireOfficial
try {
  const response = await fetch('/modules.json')
  if (!response.ok) throw new Error('Official module manifest unavailable')
  const names: Array<{ name: string }> = await response.json()
  for (const { name } of names) await load(name, `/official/${name.split('/')[1]}/client.js`)
  await import('./client.tsx')
} catch (error) {
  carrier.__hhpiFailure = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(error)
}
