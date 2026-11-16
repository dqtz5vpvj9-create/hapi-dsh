/** Resolve the installed official Client factory graph in a Node contract.
 * The loader is the boundary fixture; the package factories are unmodified. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

export function clientDependencies(fallback: (id: string) => unknown): (id: string) => unknown {
  const loaded = new Map<string, unknown>()
  const resolve = (id: string): unknown => {
    if (loaded.has(id)) return loaded.get(id)
    const file = require.resolve(id)
    if (!file.endsWith('.js')) return fallback(id)
    const code = readFileSync(file, 'utf8')
    if (!code.startsWith('window.__ModuleLoader__.load(')) return fallback(id)
    let registration: { factory(resolve: (id: string) => unknown): unknown } | undefined
    const target = globalThis.window ?? {}
    const previous = Object.getOwnPropertyDescriptor(target, '__ModuleLoader__')
    Object.defineProperty(target, '__ModuleLoader__', { configurable: true, value: { load(value: typeof registration) { registration = value } } })
    try { new Function('window', code)(target) }
    finally {
      if (previous) Object.defineProperty(target, '__ModuleLoader__', previous)
      else Reflect.deleteProperty(target, '__ModuleLoader__')
    }
    if (!registration) throw new Error(`No installed Client registration for ${id}`)
    const value = registration.factory(resolve)
    loaded.set(id, value)
    return value
  }
  return Object.assign(resolve, fallback)
}
