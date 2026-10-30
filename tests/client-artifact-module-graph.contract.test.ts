import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { orderByModuleGraph, stripClientSuffix } from '@deepseek-ai/dsh-client-modules'

const { EXTENSION_NAMES } = await import(new URL('../scripts/dsh-ext/install-extension.mjs', import.meta.url).href) as {
    EXTENSION_NAMES: readonly string[]
}

const require = createRequire(import.meta.url)
const root = new URL('../', import.meta.url)

interface OfficialClientFace {
    parseDshClient(packageName: string, value: unknown): {
        platform: string
        inject?: string[]
        external?: string[]
        immediately?: boolean
    } | undefined
    parseBootManifest(value: unknown): { modules: Array<{ id: string }> }
    stripClientSuffix(specifier: string): string
}

async function officialClientFace(): Promise<OfficialClientFace> {
    const clientPath = require.resolve('@deepseek-ai/dsh-client-modules/client')
    const source = await readFile(clientPath, 'utf8')
    const registrations: Array<{ id: string; factory: (require: (id: string) => never) => unknown }> = []
    new Function('window', source)({ __ModuleLoader__: { load: (registration: (typeof registrations)[number]) => registrations.push(registration) } })
    assert.equal(registrations.length, 1, 'the installed official browser face must register once')
    assert.equal(registrations[0]?.id, '@deepseek-ai/dsh-client-modules')
    return registrations[0]!.factory(specifier => { throw new Error(`unexpected official client dependency ${specifier}`) }) as OfficialClientFace
}

function sourceModuleIds(source: string): string[] {
    const match = source.match(/const PLATFORM_MODULES\s*=\s*\[([\s\S]*?)\]\s*as const/u)
    assert.ok(match, 'read the real federation platform module list')
    return [...match[1]!.matchAll(/'([^']+)'/gu)].map(item => item[1]!)
}

function packageClientExport(manifest: Record<string, any>): string | undefined {
    const value = manifest.exports?.['./client']
    if (typeof value === 'string') return value
    if (!value || typeof value !== 'object') return undefined
    return typeof value.browser === 'string' ? value.browser : typeof value.default === 'string' ? value.default : undefined
}

test('installed source extension client requires resolve from the actual HAPI seeds or official ClientModules graph', async () => {
    const official = await officialClientFace()
    const federationPath = new URL('src/client/federation.tsx', root)
    const federationSource = await readFile(federationPath, 'utf8')
    const runtimeStoreSource = await readFile(new URL('src/client/runtime-store.ts', root), 'utf8')
    const bundleBuildSource = await readFile(new URL('scripts/client-bundle.mjs', root), 'utf8')
    const staticSeeds = new Set(sourceModuleIds(federationSource))
    const storeId = runtimeStoreSource.match(/GRAPH_STORE_MODULE\s*=\s*'([^']+)'/u)?.[1]
    assert.ok(storeId, 'the HAPI graph store seed must be defined in its runtime source')
    assert.match(federationSource, /\[GRAPH_STORE_MODULE\]\s*:\s*createGraphStore\(/u,
        'the HAPI federation must materialize its graph store seed')
    assert.match(bundleBuildSource, /entryPoints:\s*\['@deepseek-ai\/dsh-client-store'\]/u,
        'the HAPI release build must embed the actual official store runtime')
    staticSeeds.add(storeId)
    const packages = new Map<string, { manifest: Record<string, any>; bundle: string; declaration?: ReturnType<OfficialClientFace['parseDshClient']> }>()
    const pending = [...EXTENSION_NAMES]
    while (pending.length) {
        const name = pending.shift()!
        if (packages.has(name)) continue
        const packageJson = require.resolve(`${name}/package.json`)
        const manifest = JSON.parse(await readFile(packageJson, 'utf8')) as Record<string, any>
        if (EXTENSION_NAMES.includes(name as typeof EXTENSION_NAMES[number])) {
            assert.equal(manifest.hhpiSourceExtension?.upstreamVersion, manifest.version,
                `${name} must be the installed source-built extension, not an upstream package`)
        }
        const declaration = official.parseDshClient(name, manifest.dsh?.client)
        const clientExport = packageClientExport(manifest)
        const bundle = declaration?.platform === 'web' && clientExport
            ? require.resolve(`${name}/client`)
            : ''
        packages.set(name, { manifest, bundle, declaration })
        if (!bundle) continue
        for (const dependency of [...(declaration?.inject ?? []), ...(declaration?.external ?? [])]) {
            const id = official.stripClientSuffix(dependency)
            if (!staticSeeds.has(dependency) && !staticSeeds.has(id) && !packages.has(id)) pending.push(id)
        }
    }

    const missingGraphDependencies: string[] = []
    const rows = [...packages].flatMap(([id, value]) => {
        if (!value.bundle || value.declaration?.platform !== 'web') return []
        return [{
            id,
            url: pathToFileURL(value.bundle).href,
            rev: String(value.manifest.version),
            inject: value.declaration.inject ?? [],
            external: value.declaration.external ?? [],
            immediately: value.declaration.immediately === true,
        }]
    })
    const orderedRows = orderByModuleGraph(rows)
    const graph = {
        rev: 'installed-extension-contract',
        release: { version: String(packages.get(EXTENSION_NAMES[0]!)?.manifest.version ?? 'unknown') },
        entries: orderedRows,
        batches: [{ phase: 'application', url: 'installed-extension-contract.js', rev: 'installed-extension-contract',
            entries: orderedRows.map(row => row.id) }],
    }
    const parsedGraph = official.parseBootManifest(graph)
    const materializedModules = new Set(parsedGraph.modules.map(row => row.id))
    assert.deepEqual(materializedModules, new Set(orderedRows.map(row => row.id)))
    for (const [name, value] of packages) {
        if (!value.bundle || value.declaration?.platform !== 'web') continue
        for (const dependency of [...(value.declaration.inject ?? []), ...(value.declaration.external ?? [])]) {
            const id = official.stripClientSuffix(dependency)
            if (staticSeeds.has(dependency) || staticSeeds.has(id) || materializedModules.has(id)) continue
            missingGraphDependencies.push(`${name} -> ${dependency}`)
        }
    }

    const unresolved: string[] = []
    for (const name of EXTENSION_NAMES) {
        const value = packages.get(name)!
        if (!value.bundle) continue // The installed slots package is a real shell seed, not a downloadable bundle.
        const source = await readFile(value.bundle, 'utf8')
        const requires = new Set([...source.matchAll(/\brequire\((['"])([^'"]+)\1\)/gu)].map(match => match[2]!))
        for (const specifier of requires) {
            if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
            const id = stripClientSuffix(specifier)
            if (staticSeeds.has(specifier) || staticSeeds.has(id) || materializedModules.has(id)) continue
            unresolved.push(`${name} -> ${specifier}`)
        }
    }

    assert.deepEqual(missingGraphDependencies, [], `installed extension metadata references packages absent from the official client graph:\n${missingGraphDependencies.join('\n')}`)
    assert.deepEqual(unresolved, [], `static client requires have no HAPI seed or materialized ClientModules row:\n${unresolved.join('\n')}`)
})
