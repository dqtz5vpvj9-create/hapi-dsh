/** Bounded component lab: serve unmodified installed official browser bundles. */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises'
import { resolve, dirname, join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { EXTENSION_NAMES } from '../../scripts/dsh-ext/install-extension.mjs'

const require = createRequire(import.meta.url)
export const root = resolve(import.meta.dirname, '../..')
export const output = resolve(root, '.tmp/hhpi-browser/site')
const plugins = ['api-session-controller', 'client-ui-renderer', 'client-ui-session', 'client-ui-conversation', 'client-ui-chat', 'client-ui-tool', 'client-ui-attachment'].map(name => `@deepseek-ai/dsh-${name}`)
const platform = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']

/** Node resolution must not select the Node half of a dual-client package. */
function browserEntry(name) {
  const metadataPath = require.resolve(`${name}/package.json`), metadata = require(metadataPath)
  const face = metadata.exports?.['./client']
  const entry = typeof face === 'string' ? face : face?.browser ?? face?.default
  if (typeof entry !== 'string' || !entry.startsWith('./')) throw new Error(`No declared browser client entry: ${name}`)
  return { metadata, entry: resolve(dirname(metadataPath), entry) }
}

/** Build the actual module-table closure and static-library roster from literal require seats. */
async function copyPluginClosure(version) {
  const pending = new Set(plugins), staticModules = new Set(platform), modules = []
  for (const name of pending) {
    const { metadata, entry } = browserEntry(name)
    if (metadata.version !== version) throw new Error(`Mixed official dependency: ${name}@${metadata.version}`)
    const directory = dirname(entry), target = join(output, 'official', name.split('/')[1])
    await mkdir(target, { recursive: true })
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.js') || file.endsWith('.node.js') || (file !== basename(entry) && !file.startsWith('client.'))) continue
      const source = join(directory, file), text = await readFile(source, 'utf8')
      for (const match of text.matchAll(/\brequire(?:\.async)?\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const id = match[1]
        if (id.startsWith('.')) continue
        if (id.startsWith('node:')) throw new Error(`Node-only dependency leaked into ${name}: ${id}`)
        if (/^@deepseek-ai\/dsh-.*\/client$/.test(id)) pending.add(id.slice(0, -7))
        else staticModules.add(id)
      }
      await copyFile(source, join(target, file))
    }
    // URL alias only; the selected official browser bytes are unchanged.
    await copyFile(entry, join(target, 'client.js'))
    modules.push({ name, browserEntry: basename(entry), sha256: createHash('sha256').update(await readFile(entry)).digest('hex') })
    if (pending.size > 80 || staticModules.size > 80) throw new Error('Official dependency closure exceeded the component-lab budget')
  }
  await writeFile(join(output, 'modules.json'), JSON.stringify(modules))
  return { modules, staticModules: [...staticModules] }
}

export async function buildLab() {
  const start = performance.now(), source = process.env.HHPI_DSH_SOURCE
  if (!source) throw new Error('HHPI_DSH_SOURCE must name the prepared, built pinned extension source.')
  const identity = JSON.parse(await readFile(join(root, '.tmp/hhpi-ext/installed.json'), 'utf8'))
  const artifacts = []
  for (const name of EXTENSION_NAMES) {
    const metadata = require(`${name}/package.json`)
    if (metadata.version !== identity.upstreamVersion || metadata.hhpiSourceExtension?.upstreamCommit !== identity.upstreamCommit || metadata.hhpiSourceExtension?.patchSetSha256 !== identity.patchSetSha256) throw new Error(`Unverified installed extension: ${name}`)
    const entry = metadata.exports?.['./client'] ? browserEntry(name).entry : require.resolve(name)
    artifacts.push({ name, entry: basename(entry), sha256: createHash('sha256').update(await readFile(entry)).digest('hex') })
  }
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true })
  const { modules: officialModules, staticModules } = await copyPluginClosure(identity.upstreamVersion)
  const imports = staticModules.map(name => name === '@deepseek-ai/dsh-client-ui-dockkit' ? join(source, 'packages/client/ui-dockkit/src/index.ts') : name)
  const theme = ['base', 'corner-shape', 'design-platform', 'focus', 'onboarding', 'scrollbar', 'gradient-shadow-text', 'shiki']
  const platformSource = imports.map((path, i) => `import * as m${i} from ${JSON.stringify(path)};`).join('\n')
    + `\nexport const modules = {${staticModules.map((name, i) => `${JSON.stringify(name)}: m${i}`).join(',')}};\n`
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
  const report = { ...identity, artifacts, officialModules, staticModules, buildMs: Math.round(performance.now() - start), geometryMocks: false, shell: 'two-pane component fixture', sourceTransport: 'synthetic loopback SourceEventIndex' }
  await writeFile(join(output, 'identity.json'), JSON.stringify(report, null, 2)); return report
}
