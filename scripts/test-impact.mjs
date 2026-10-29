import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const codePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
const slash = value => value.split(path.sep).join('/')

export function repositoryPath(root, file) {
  const relative = slash(path.relative(root, path.resolve(root, file)))
  if (!relative || relative === '..' || relative.startsWith('../')) {
    throw new Error(`Expected a file inside the repository: ${file}`)
  }
  return relative
}

function walk(root, directory) {
  const absolute = path.join(root, directory)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`
    return entry.isDirectory() ? walk(root, file) : entry.isFile() ? [file] : []
  })
}

export function discoverTests(root) {
  const files = walk(root, 'tests')
  return {
    node: files.filter(file => /^tests\/[^/]+\.test\.ts$/.test(file)).sort(),
    experience: files.filter(file => /^tests\/experience\/.+\.test\.tsx$/.test(file)).sort(),
  }
}

// Git -z uses separate status/path fields, including BOTH paths for a rename.
export function changedPathsFromStatus(output) {
  const fields = output.split('\0')
  const files = []
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++]
    files.push(fields[index++])
    if (/^[RC]/.test(status)) files.push(fields[index++])
  }
  return files.filter(Boolean)
}

export function collectChangedFiles(root, { since, files } = {}) {
  if (files && since) throw new Error('--files and --since cannot be combined')
  if (files) return [...new Set(files.map(file => repositoryPath(root, file)))].sort()
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 })
  const base = since ? git(['rev-parse', '--verify', '--end-of-options', `${since}^{commit}`]).trim() : undefined
  const differences = since
    ? [git(['diff', '--name-status', '-z', '--find-renames', base, '--'])]
    : [git(['diff', '--name-status', '-z', '--find-renames', '--']),
      git(['diff', '--cached', '--name-status', '-z', '--find-renames', '--'])]
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  return [...new Set([...differences.flatMap(changedPathsFromStatus), ...untracked])].sort()
}

function candidates(base) {
  if (/\.jsx?$/.test(base)) {
    return [base.replace(/\.jsx?$/, '.ts'), base.replace(/\.jsx?$/, '.tsx'), base]
  }
  if (/\.[mc]js$/.test(base)) return [base.replace(/js$/, 'ts'), base]
  if (path.extname(base)) return [base]
  return [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'].map(ext => base + ext),
    ...['.ts', '.tsx', '.js', '.mjs'].map(ext => `${base}/index${ext}`)]
}

function dependencyGraph(root) {
  const dependants = new Map()
  const opaque = new Set()
  const files = ['src', 'tests', 'scripts'].flatMap(directory => walk(root, directory)).filter(file => codePattern.test(file))
  const add = (importer, specifier, fromRoot = false) => {
    if (!fromRoot && !specifier.startsWith('.')) return
    const base = slash(path.normalize(path.join(fromRoot ? '' : path.dirname(importer), specifier)))
    const possible = candidates(base)
    const existing = possible.find(file => existsSync(path.join(root, file)))
    // Preserve unresolved candidates so deleted .ts modules imported as .js are found.
    for (const dependency of existing ? [existing] : possible) {
      if (!dependants.has(dependency)) dependants.set(dependency, new Set())
      dependants.get(dependency).add(importer)
    }
  }
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
    let hasBundleSource = false
    let hasUnknownImport = false
    let hasDataImport = false
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        add(file, node.moduleSpecifier.text)
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteralLike(argument)) add(file, argument.text)
        else if (argument && ts.isTemplateExpression(argument) && argument.head.text.startsWith('data:')) hasDataImport = true
        else hasUnknownImport = true
      }
      // Existing contract tests bundle literal source entrypoints with esbuild.
      if (ts.isStringLiteralLike(node) && /^(?:src\/|(?:\.\.\/)+src\/)/.test(node.text)) {
        add(file, node.text, node.text.startsWith('src/'))
        hasBundleSource = true
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (hasUnknownImport || (hasDataImport && !hasBundleSource)) opaque.add(file)
  }
  return { dependants, opaque }
}

function reachableTests(start, graph, tests) {
  const found = new Set()
  const visited = new Set()
  const pending = [start]
  while (pending.length) {
    const file = pending.pop()
    if (visited.has(file)) continue
    visited.add(file)
    if (tests.has(file)) found.add(file)
    pending.push(...(graph.get(file) ?? []))
  }
  return found
}

function documentation(file) {
  // Text under src/tests can be a runtime resource or fixture, not documentation.
  return file.startsWith('docs/') || (!/^(?:src|tests)\//.test(file) && /\.(?:md|mdx|rst|txt)$/i.test(file)) ||
    /^(?:LICENSE|NOTICE)(?:\..*)?$/.test(file)
}

function sharedConfiguration(file) {
  return /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|UPSTREAMS\.json|tsconfig(?:\.[^/]+)?\.json|vitest\.config\.[^/]+|\.npmrc)$/.test(file) ||
    /^(?:config|locale|\.github)\//.test(file) || file === 'tests/experience/setup.ts'
}

export function selectTests(root, changedFiles) {
  const inventory = discoverTests(root)
  const changed = [...new Set(changedFiles.map(file => repositoryPath(root, file)))].sort()
  const all = new Set([...inventory.node, ...inventory.experience])
  const result = (selection, reason, selected = [], warnings = []) => ({
    selection, reason, changed, node: inventory.node.filter(file => selected.includes(file)),
    experience: inventory.experience.filter(file => selected.includes(file)), warnings,
  })
  const full = reason => result('full', reason, [...all])
  if (!changed.length) return result('none', 'No changed files; no tests executed.')
  const relevant = changed.filter(file => !documentation(file))
  if (!relevant.length) return result('none', 'Documentation-only changes; no tests executed.')
  const config = relevant.find(sharedConfiguration)
  if (config) return full(`Shared configuration or dependency changed: ${config}`)
  const { dependants, opaque } = dependencyGraph(root)
  const selected = new Set()
  const warnings = ['Static dependency selection is not a complete model of runtime-loaded files or external services.']
  for (const file of relevant) {
    const matching = reachableTests(file, dependants, all)
    if (!matching.size) return full(`No test mapping for changed file (including removed files): ${file}`)
    for (const test of matching) selected.add(test)
  }
  // Computed imports with no known bundle entrypoint are conservatively included.
  let dynamicTests = 0
  for (const file of opaque) {
    for (const test of reachableTests(file, dependants, all)) {
      if (!selected.has(test)) dynamicTests++
      selected.add(test)
    }
  }
  if (dynamicTests) warnings.push(`Also selected ${dynamicTests} test files that depend on unresolved dynamic imports.`)
  return result('affected', 'Selected through imports, re-exports, source entrypoint literals and shared helpers.', [...selected], warnings)
}
