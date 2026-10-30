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
    outfile: resolve(source, '.hhpi-contract-library.js'),
    loader: { '.css': 'css', '.module.css': 'local-css', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    logLevel: 'silent',
  })
  const output = result.outputFiles.find(file => file.path.endsWith('.js'))
  if (!output) throw new Error('The official browser library produced no JavaScript output.')
  const module = { exports: {} as Record<string, unknown> }
  new Function('require', 'module', 'exports', output.text)(require, module, module.exports)
  // Real CSS/font inputs are compiled in memory. jsdom is not layout evidence.
  primitives = module.exports
}

export function resolveOfficialBrowserDependency(id: string): unknown {
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    if (!primitives) throw new Error('The real UI library has not been prepared.')
    return primitives
  }
  return require(id)
}
