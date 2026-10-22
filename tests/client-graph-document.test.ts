/** Real pinned CSS emitter and module loader; document surfaces are protocol fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import { createGraphModules, graphStyleQueries } from '../src/client/graph-document.ts'

const require = createRequire(import.meta.url)
const bundle = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8')
const start = bundle.indexOf('\t\tconst css$9 =')
assert.ok(start > 0)
const cssBlock = bundle.slice(start, bundle.indexOf('\n\t\t//#endregion', start))
const prefix = cssBlock.match(/"([A-Za-z0-9_-]+)_root"/)![1]!
const modulesSource = readFileSync(require.resolve('@deepseek-ai/dsh-client-modules/client'), 'utf8')
const plugin = '@deepseek-ai/dsh-client-ui-conversation'

function fixture() {
    class Style {
        dataset: Record<string, string> = {}
        textContent = ''
        removed = false
        getAttribute(name: string) { return this.dataset[name === 'data-plugin-css' ? 'pluginCss' : 'plugin'] ?? null }
        setAttribute(name: string, value: string) { this.dataset[name === 'data-plugin-css' ? 'pluginCss' : 'plugin'] = value }
        remove() { this.removed = true }
    }
    const primary: Style[] = [], remote: Style[] = [], sibling: Style[] = []
    const editor = { id: 'portal-editor-outside-style-container' }
    const root = (nodes: () => Style[]) => ({
        querySelector(selector: string) { return selector === '[data-composer-input]' ? editor : this.querySelectorAll(selector)[0] ?? null },
        querySelectorAll(selector: string) {
            return nodes().filter(node => !node.removed && (selector === 'style:not([data-plugin])' ? !node.dataset.plugin
                : selector === 'style[data-plugin]' ? Boolean(node.dataset.plugin)
                : selector === `style[data-plugin=${JSON.stringify(node.dataset.plugin)}]`
                    || selector === `style[data-plugin-css=${JSON.stringify(node.dataset.pluginCss)}]`))
        },
    })
    const page = root(() => [...primary, ...remote, ...sibling])
    const doc = (nodes: Style[], scoped: boolean) => ({
        head: { appendChild(node: Style) { nodes.push(node) } }, createElement() { return new Style() },
        ...(scoped ? graphStyleQueries(page as unknown as ParentNode, root(() => nodes) as unknown as ParentNode) : page),
    }) as unknown as Document
    const inject = (document: Document, classPrefix = prefix) => new Function('document', cssBlock.replaceAll(prefix, classPrefix))(document)
    return { primary, remote, sibling, editor, doc, inject }
}

test('same CSS filename from another build used to suppress the remote stylesheet', () => {
    const f = fixture()
    f.inject(f.doc(f.primary, false))
    f.inject(f.doc(f.remote, false), 'remote_build')
    assert.equal(f.primary.length, 1)
    assert.equal(f.remote.length, 0, 'reproduces the original page-global dedupe failure')
    f.inject(f.doc(f.remote, true), 'remote_build')
    f.inject(f.doc(f.remote, true), 'remote_build')
    assert.equal(f.remote.length, 1, 'the remote graph keeps its own stylesheet without duplicating it')
    assert.match(f.remote[0]!.textContent, /remote_build_root/)
    assert.ok(!f.primary[0]!.textContent.includes('remote_build'))
})

test('graph CSS cleanup stays local while conversation DOM lookup still reaches portals', () => {
    const f = fixture()
    f.inject(f.doc(f.primary, false))
    f.inject(f.doc(f.remote, true), 'remote_build')
    f.inject(f.doc(f.sibling, true), 'sibling_build')
    const remote = f.doc(f.remote, true)
    assert.equal(remote.querySelector('[data-composer-input]'), f.editor)
    for (const style of remote.querySelectorAll('style[data-plugin]')) style.remove()
    assert.equal(f.primary[0]!.removed, false)
    assert.equal(f.remote[0]!.removed, true)
    assert.equal(f.sibling[0]!.removed, false)
})

test('the unchanged official loader inventories only the styles of its own graph', async () => {
    const f = fixture()
    f.inject(f.doc(f.primary, false))
    const document = f.doc(f.remote, true)
    const official = createGraphModules(document, modulesSource)
    const target: ClientModuleLoaderTarget = {
        mode: 'queue', pendingQueue: [{ id: plugin, factory: () => { f.inject(document, 'remote_build'); return { ready: true } } }],
        load() { throw new Error('registration target should be activated by the official loader') },
        create() { throw new Error('fixture invokes the public factory directly') },
    }
    const modules = official.createClientModuleSystem(target, { id: '@deepseek-ai/dsh-client-modules', exports: official as unknown as Record<string, unknown> }, {
        boot: { rev: 'fixture', entries: [], batches: [] }, staticModules: {},
    })
    assert.deepEqual(await modules.import(plugin), { ready: true })
    assert.deepEqual(modules.loadCache.get(plugin)!.styles, [`${plugin}/UserText.module.css`])
    assert.equal(f.primary.length, 1)
    assert.equal(f.remote.length, 1)
})
