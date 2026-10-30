/** Bounded component lab: serve unmodified installed official client bundles. */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { EXTENSION_NAMES } from '../../scripts/dsh-ext/install-extension.mjs'

const require = createRequire(import.meta.url)
export const root = resolve(import.meta.dirname, '../..')
export const output = resolve(root, '.tmp/hhpi-browser/site')
const plugins = ['api-session-controller', 'client-ui-renderer', 'client-ui-session', 'client-ui-conversation', 'client-ui-chat'].map(name => `@deepseek-ai/dsh-${name}`)
const platform = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']

/** Traverse literal official client imports, without loading or rewriting any factory. */
async function copyPluginClosure(version) {
  const pending = new Set(plugins), modules = []
  for (const name of pending) {
    const metadata = require(`${name}/package.json`)
    if (metadata.version !== version) throw new Error(`Mixed official dependency: ${name}@${metadata.version}`)
    const entry = require.resolve(`${name}/client`), directory = dirname(entry)
    const target = join(output, 'official', name.split('/')[1])
    await mkdir(target, { recursive: true })
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.js')) continue
      const source = join(directory, file), text = await readFile(source, 'utf8')
      for (const match of text.matchAll(/["'](@deepseek-ai\/dsh-[^"'\s]+\/client)["']/g)) pending.add(match[1].slice(0, -7))
      await copyFile(source, join(target, file))
    }
    modules.push({ name, sha256: createHash('sha256').update(await readFile(entry)).digest('hex') })
    if (pending.size > 80) throw new Error('Official dependency closure exceeded the component-lab budget')
  }
  await writeFile(join(output, 'modules.json'), JSON.stringify(modules))
  return modules
}

export async function buildLab() {
  const start = performance.now(), source = process.env.HHPI_DSH_SOURCE
  if (!source) throw new Error('HHPI_DSH_SOURCE must name the prepared, built pinned extension source.')
  const identity = JSON.parse(await readFile(join(root, '.tmp/hhpi-ext/installed.json'), 'utf8'))
  const artifacts = []
  for (const name of EXTENSION_NAMES) {
    const metadata = require(`${name}/package.json`)
    if (metadata.version !== identity.upstreamVersion || metadata.hhpiSourceExtension?.upstreamCommit !== identity.upstreamCommit || metadata.hhpiSourceExtension?.patchSetSha256 !== identity.patchSetSha256) throw new Error(`Unverified installed extension: ${name}`)
    const entry = metadata.exports?.['./client'] ? `${name}/client` : name
    artifacts.push({ name, entry, sha256: createHash('sha256').update(await readFile(require.resolve(entry))).digest('hex') })
  }
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true })
  const officialModules = await copyPluginClosure(identity.upstreamVersion)
  const searchPaths = [root, join(source, 'packages/client/web'), join(source, 'packages/client/ui-primitives'), source]
  const modules = platform.map(name => name === '@deepseek-ai/dsh-client-ui-dockkit'
    ? join(source, 'packages/client/ui-dockkit/src/index.ts') : require.resolve(name, { paths: searchPaths }))
  const theme = ['base', 'corner-shape', 'design-platform', 'focus', 'onboarding', 'scrollbar', 'gradient-shadow-text', 'shiki']
  const platformSource = modules.map((path, i) => `import * as m${i} from ${JSON.stringify(path)};`).join('\n')
    + `\nexport const modules = {${platform.map((name, i) => `${JSON.stringify(name)}: m${i}`).join(',')}};\n`
    + theme.map(name => `import ${JSON.stringify(join(source, 'packages/client/ui-theme/src/styles', `${name}.css`))};`).join('\n')
    + `\nimport ${JSON.stringify(join(source, 'packages/client/web/src/base.css'))};\n`
  const result = await build({
    entryPoints: { lab: join(root, 'tests/browser/bootstrap.ts') }, outdir: output,
    bundle: true, platform: 'browser', format: 'esm', splitting: true, target: 'es2024', sourcemap: true, metafile: true,
    nodePaths: [join(root, 'node_modules'), join(source, 'packages/client/ui-primitives/node_modules'), join(source, 'packages/client/web/node_modules'), join(source, 'node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), '@deepseek-ai/cordis': require.resolve('@deepseek-ai/cordis') },
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'css', '.module.css': 'local-css', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [{ name: 'official-lab-boundaries', setup(builder) {
      builder.onResolve({ filter: /^hhpi-platform$/ }, () => ({ path: 'platform', namespace: 'lab' }))
      builder.onResolve({ filter: /^hhpi-window-commit$/ }, () => ({ path: '@deepseek-ai/dsh-api-session-controller/client', namespace: 'installed-client' }))
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-.*\/client$/ }, args => ({ path: args.path, namespace: 'installed-client' }))
      builder.onLoad({ filter: /.*/, namespace: 'installed-client' }, args => ({ contents: `module.exports = globalThis.__HHPI_REQUIRE__(${JSON.stringify(args.path)});`, loader: 'js' }))
      builder.onLoad({ filter: /.*/, namespace: 'lab' }, () => ({ contents: platformSource, loader: 'ts', resolveDir: root }))
    } }], logLevel: 'warning',
  })
  const sheets = Object.keys(result.metafile.outputs).filter(path => path.endsWith('.css')).map(path => '/' + path.slice(path.lastIndexOf('/') + 1))
  await writeFile(join(output, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>HHPI official component lab</title>${sheets.map(path => `<link rel="stylesheet" href="${path}">`).join('')}<link rel="stylesheet" href="/shell.css"></head><body><div id="root"></div><script type="module" src="/lab.js"></script></body></html>`)
  await copyFile(join(root, 'tests/browser/shell.css'), join(output, 'shell.css'))
  const report = { ...identity, artifacts, officialModules, buildMs: Math.round(performance.now() - start), geometryMocks: false, shell: 'two-pane component fixture', sourceTransport: 'synthetic loopback SourceEventIndex' }
  await writeFile(join(output, 'identity.json'), JSON.stringify(report, null, 2)); return report
}
