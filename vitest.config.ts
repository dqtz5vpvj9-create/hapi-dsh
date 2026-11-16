import { defineConfig } from 'vitest/config'
import { faults } from './tests/experience/faults.ts'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

// Published DSH UI libraries are loaded by the browser's module graph. Node
// contracts use the pinned upstream dependency graph, just as reading tests do.
// Compile outside jsdom so native esbuild and browser typed arrays don't mix.
const require = createRequire(import.meta.url)
const officialUiId = '\0hhpi-test:official-ui'
let officialUi: Promise<string> | undefined
const officialUiPlugin = {
  name: 'official-ui-contract',
  resolveId(id: string) { if (id === officialUiId || id === '@deepseek-ai/dsh-client-ui-primitives') return officialUiId },
  load(id: string) {
    if (id !== officialUiId) return
    return officialUi ??= (async () => {
      const source = process.env.HHPI_DSH_SOURCE
      if (!source) throw new Error('Official UI contracts need HHPI_DSH_SOURCE with the pinned dependency graph.')
      const result = await build({
        entryPoints: [require.resolve('@deepseek-ai/dsh-client-ui-primitives')],
        nodePaths: [resolve(source, 'packages/client/ui-primitives/node_modules'), resolve(source, 'node_modules')],
        external: ['react', 'react-dom', '@deepseek-ai/cordis'],
        bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false,
        outfile: 'official-ui-contract.js',
        loader: { '.css': 'css', '.module.css': 'local-css', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
        logLevel: 'silent',
      })
      const output = result.outputFiles.find(file => file.path.endsWith('.js'))
      if (!output) throw new Error('Official UI contract produced no JavaScript.')
      return output.text
    })()
  },
}

const faultName = process.env.HAPI_DSH_TEST_FAULT
if (faultName && !(faultName in faults)) throw new Error(`Unknown experience fault: ${faultName}`)
const fault = faultName ? faults[faultName as keyof typeof faults] : undefined

export default defineConfig({
  resolve: { alias: { '@deepseek-ai/dsh-client-ui-primitives': officialUiId } },
  plugins: [officialUiPlugin, ...(fault ? [{
    name: 'experience-fault', enforce: 'pre' as const,
    transform(code: string, id: string) {
      const modulePath = id.replaceAll('\\', '/').split('?', 1)[0]!
      if (!modulePath.endsWith(`/${fault.file}`)) return
      if (code.split(fault.before).length !== 2) throw new Error(`Fault target changed: ${faultName}`)
      return { code: code.replace(fault.before, fault.after), map: null }
    },
  }] : [])],
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/experience/**/*.test.tsx', 'tests/source-voice*.test.tsx'],
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'https://experience.invalid/' } },
    setupFiles: ['tests/experience/setup.ts'],
    // Deterministic interaction tests, not CPU benchmarks. Bound worker memory.
    maxWorkers: 2,
    testTimeout: 5_000,
    hookTimeout: 10_000,
    retry: 0,
    clearMocks: true,
  },
})
