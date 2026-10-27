/** Executes the emitted script with a real HTML parser/DOM and deterministic
 * browser scheduling. Synthetic geometry stands in for layout; browser timing
 * and visual correctness remain the pinned-runtime e2e's responsibility. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { initialWorkspace, WorkspaceStore } from '../src/client/model.ts'
import { deferWorkspaceEntry, workspaceBootInjections, WORKSPACE_BOOT_SCRIPT } from '../src/shared/workspace-boot.ts'

const require = createRequire(import.meta.url)
// Exact transitive dependency already present in package-lock through turndown.
const { createWindow } = require('@mixmark-io/domino') as { createWindow(html: string, url: string): Window }
const entry = '<script type="module" crossorigin="anonymous" nonce="fixture-nonce" src="./assets/index-fixture.js"></script>'
const injected = (scripts = entry): string => `<!doctype html><html><head>${scripts}</head><body><script>${WORKSPACE_BOOT_SCRIPT}</script></body></html>`

function boot(options: { saved?: unknown; raw?: string; href?: string; hidden?: boolean; deniedStorage?: boolean } = {}) {
    const href = options.href ?? 'https://fixture.invalid/app/'
    const document = createWindow(deferWorkspaceEntry(injected()), href).document
    const originalCreate = document.createElement.bind(document)
    // Domino intentionally omits newer DOM conveniences; these are general DOM
    // operations, with parsing, textContent and selectors supplied by Domino.
    const extend = (element: HTMLElement): HTMLElement => {
        if (typeof element.dataset === 'undefined') Object.defineProperty(element, 'dataset', { value: new Proxy({}, {
            set(_target, key, value) {
                element.setAttribute(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, String(value))
                return true
            },
        }) })
        if (typeof element.append !== 'function') element.append = (...nodes) => {
            for (const node of nodes) element.appendChild(typeof node === 'string' ? document.createTextNode(node) : node)
        }
        if (typeof element.replaceChildren !== 'function') element.replaceChildren = (...nodes) => {
            while (element.firstChild) element.removeChild(element.firstChild)
            element.append(...nodes)
        }
        return element
    }
    document.createElement = ((name: string) => extend(originalCreate(name))) as Document['createElement']
    for (const element of document.querySelectorAll<HTMLElement>('*')) extend(element)
    Object.defineProperty(document, 'visibilityState', { value: options.hidden ? 'hidden' : 'visible' })
    const frames: Array<() => void> = []
    const timers = new Map<number, { callback: () => void; delay: number }>()
    const observers = new Set<{ callback: () => void; options?: MutationObserverInit }>()
    const marks: string[] = [], storageReads: string[] = []
    let timerId = 0, reloads = 0
    const location = new URL(href) as URL & { reload(): void }
    location.reload = () => { reloads++ }
    const saved = options.raw ?? (options.saved === undefined ? null : JSON.stringify(options.saved))
    runInNewContext(WORKSPACE_BOOT_SCRIPT, {
        document, location, URL, navigator: { language: 'en' },
        localStorage: { getItem(key: string) { storageReads.push(key); if (options.deniedStorage) throw new Error('denied'); return saved } },
        performance: { mark(name: string) { marks.push(name) } },
        requestAnimationFrame(callback: () => void) { frames.push(callback); return frames.length },
        setTimeout(callback: () => void, delay: number) { timers.set(++timerId, { callback, delay }); return timerId },
        clearTimeout(id: number) { timers.delete(id) },
        MutationObserver: class {
            readonly record: { callback: () => void; options?: MutationObserverInit }
            constructor(callback: () => void) { this.record = { callback } }
            observe(_target: Node, options: MutationObserverInit) { this.record.options = options; observers.add(this.record) }
            disconnect() { observers.delete(this.record) }
        },
    }, { timeout: 1_000 })
    return {
        document, marks, storageReads, observers,
        pendingFrames: () => frames.length,
        pendingTimers: () => [...timers.values()].map(timer => timer.delay),
        root: () => document.querySelector<HTMLElement>('[data-hapi-workspace-boot]'),
        frame() { const current = frames.splice(0); for (const callback of current) callback() },
        time(delay: number) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback() } },
        mutation(type: 'childList' | 'attributes' = 'childList') {
            for (const observer of [...observers]) if (observer.options?.[type]) observer.callback()
        },
        reloads: () => reloads,
    }
}

function layout() {
    let sequence = 0
    const next = () => `boot-${++sequence}`
    const store = new WorkspaceStore(initialWorkspace(next), next)
    store.openSession('synthetic-a')
    store.split('horizontal', { kind: 'chat', sessionId: 'synthetic-b' })
    store.resize(store.active().root.id, 0, 3, 1)
    store.split('vertical', { kind: 'chat', sessionId: 'synthetic-c' })
    return store
}

test('boot carrier only defers the known official entry when its release script is injected', () => {
    assert.equal(deferWorkspaceEntry(entry), entry)
    for (const candidate of [
        '<script type="module" src="/other-entry.js"></script>',
        '<script src="./assets/index-fixture.js"></script>',
        '<script type="module">console.log("inline")</script>',
    ]) assert.equal(deferWorkspaceEntry(injected(candidate)), injected(candidate))
    const output = deferWorkspaceEntry(injected())
    assert.match(output, /type="application\/x-hapi-entry" crossorigin="anonymous" nonce="fixture-nonce" src="\.\/assets\/index-fixture\.js"/)
    assert.equal(workspaceBootInjections().filter(item => item.kind === 'script').length, 1)
})

test('boot script releases exactly one unchanged official module without waiting for paint or a timer', () => {
    const result = boot()
    assert.ok(result.root())
    assert.equal(result.document.querySelectorAll('script[type="module"]').length, 1)
    assert.deepEqual(result.marks, ['hapi:boot-layout'])
    assert.equal(result.pendingFrames(), 0)
    assert.deepEqual(result.pendingTimers(), [15_000])
    const module = result.document.querySelector('script[type="module"]')!
    assert.equal(module.getAttribute('src'), './assets/index-fixture.js')
    assert.equal(module.getAttribute('nonce'), 'fixture-nonce')
    assert.equal(module.getAttribute('crossorigin'), 'anonymous')
    result.time(250)
    assert.equal(result.document.querySelectorAll('script[type="module"]').length, 1)
    assert.equal(result.document.querySelectorAll('script[type="application/x-hapi-entry"]').length, 0)
    // The preview cannot impersonate the actual ready workspace.
    assert.equal(result.document.querySelector('[data-hapi-workspace]') ?? null, null)
})

test('a throttled paint, hidden tab and explicit boot opt-out do not delay the official module', () => {
    const throttled = boot()
    assert.equal(throttled.document.querySelectorAll('script[type="module"]').length, 1)
    assert.equal(throttled.pendingFrames(), 0)
    throttled.time(250)
    throttled.frame(); throttled.frame()
    assert.equal(throttled.document.querySelectorAll('script[type="module"]').length, 1)
    const hidden = boot({ hidden: true })
    assert.equal(hidden.document.querySelectorAll('script[type="module"]').length, 1)
    const off = boot({ href: 'https://fixture.invalid/app/?hapiBoot=off' })
    assert.equal(off.root() ?? null, null)
    assert.equal(off.document.querySelectorAll('script[type="module"]').length, 1)
})

test('boot restores the actual persisted split geometry and treats saved labels as plain text', () => {
    const store = layout()
    const attack = '<img src=x onerror="globalThis.bootInjected=true">'
    store.renameWindow(store.active().id, attack)
    const result = boot({ saved: store.getSnapshot() })
    assert.equal(result.document.querySelectorAll('[data-boot-pane]').length, 3)
    const splits = [...result.document.querySelectorAll<HTMLElement>('[data-boot-split]')]
    assert.deepEqual(splits.map(split => split.style.flexDirection), ['row', 'column'])
    assert.match(splits[0]!.firstElementChild!.getAttribute('style')!, /flex:\s*3 1 0/)
    assert.equal(result.document.querySelector('footer span')!.textContent, attack)
    assert.equal(result.document.querySelector('footer span')!.getAttribute('aria-current'), 'true')
    assert.equal(result.document.querySelector('img') ?? null, null)
    assert.ok(!result.root()!.textContent?.includes('synthetic-a'))
    assert.deepEqual(result.storageReads, ['hapi-dsh:workspace:v1:https://fixture.invalid/app/'])
})

test('boot honors the saved zoomed pane and falls back for broken or unavailable layout storage', () => {
    const store = layout(); store.toggleZoom()
    assert.equal(boot({ saved: store.getSnapshot() }).document.querySelectorAll('[data-boot-pane]').length, 1)
    for (const options of [
        { raw: '{broken' }, { deniedStorage: true }, { raw: 'x'.repeat(1_048_577) },
        { saved: { ...store.getSnapshot(), windows: [{ id: store.active().id, root: { type: 'split', axis: 'diagonal', children: [], weights: [] } }] } },
    ]) {
        const result = boot(options)
        assert.equal(result.document.querySelectorAll('[data-boot-pane]').length, 1)
        assert.match(result.root()!.textContent!, /Your workspace is starting/)
        assert.equal(result.document.querySelectorAll('script[type="module"]').length, 1)
    }
})

test('boot stays for a hidden workspace, then removes itself once the actual workspace has geometry', () => {
    const result = boot()
    const workspace = result.document.createElement('section')
    workspace.setAttribute('data-hapi-workspace', '')
    let visible = false
    workspace.getClientRects = () => (visible ? [{}] : []) as unknown as DOMRectList
    result.document.body.append(workspace)
    result.mutation()
    assert.ok(result.root())
    visible = true
    workspace.style.display = 'flex'
    result.mutation('attributes')
    assert.equal(result.root() ?? null, null)
    assert.equal(result.observers.size, 0)
    assert.deepEqual(result.marks, ['hapi:boot-layout', 'hapi:workspace-ready'])
    result.time(15_000)
    assert.equal(result.document.querySelector('button') ?? null, null)
})

test('boot timeout exposes a real retry action without declaring the workspace ready', () => {
    const result = boot()
    result.time(15_000)
    assert.match(result.document.querySelector('[role="status"]')!.textContent!, /Still connecting/)
    const retry = result.document.querySelector<HTMLButtonElement>('button')!
    assert.equal(retry.textContent, 'Reload')
    retry.click()
    assert.equal(result.reloads(), 1)
    assert.deepEqual(result.marks, ['hapi:boot-layout'])
})
