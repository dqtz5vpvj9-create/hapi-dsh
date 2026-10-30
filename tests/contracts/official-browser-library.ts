/** Load the actual official UI library with its pinned browser-graph dependencies in Node. */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const require = createRequire(import.meta.url)
let primitives: Record<string, unknown> | undefined

export async function prepareOfficialBrowserLibrary(): Promise<void> {
  if (primitives !== undefined) return
  const source = process.env.HHPI_DSH_SOURCE
  if (!source) throw new Error('The installed UI integration needs its pinned upstream dependency graph.')
  const result = await build({
    entryPoints: [require.resolve('@deepseek-ai/dsh-client-ui-primitives')],
    nodePaths: [resolve(source, 'packages/client/ui-primitives/node_modules'), resolve(source, 'node_modules')],
    external: ['react', 'react-dom', '@deepseek-ai/cordis'],
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false,
    loader: { '.css': 'empty' }, logLevel: 'silent',
  })
  const module = { exports: {} as Record<string, unknown> }
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(require, module, module.exports)
  primitives = module.exports
}

export function resolveOfficialBrowserDependency(id: string): unknown {
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    if (!primitives) throw new Error('The real UI library has not been prepared.')
    return primitives
  }
  return require(id)
}
