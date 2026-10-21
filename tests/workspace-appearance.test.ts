/** Original preference fixtures plus the unchanged official ThemeRuntime.
 * Host settings and source catalogs are explicit boundary fixtures. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ThemeRuntime, ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { createWorkspaceUiPreferences } from '../src/client/ui-preferences.ts'
import { AppearanceState, bindAppearanceTheme } from '../src/client/appearance/state.ts'
import { DEFAULT_HEADER, parseColors, parseHeader, readAppearance } from '../src/client/appearance/preferences.ts'
import { appearanceTokens, keyColors } from '../src/client/appearance/tokens.ts'
import { terminalTheme } from '../src/client/appearance/terminal-theme.ts'
import { sourceHeaderFacts } from '../src/client/appearance/header.tsx'
import type { HapiProjection } from '../src/codex/projection-types.ts'
import type { WorkspaceCatalogRow } from '../src/client/controller.ts'

function storage(entries: Array<[string, string]> = []) {
    const values = new Map(entries)
    const preferences = createWorkspaceUiPreferences({ getItem: key => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } })
    return { values, preferences }
}
function officialTheme() {
    const require = createRequire(import.meta.url)
    let registration: { factory(resolve: (id: string) => unknown): Record<string, unknown> } | undefined
    new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-theme/client'), 'utf8'))({
        __ModuleLoader__: { load(value: typeof registration) { registration = value } },
    })
    assert.ok(registration)
    // Official module evaluation retains icon component references; this model
    // test never renders one or invokes a store/view helper.
    const unused = new Proxy({}, { get() { return () => { throw new Error('This model-only test unexpectedly mounted a UI service') } } })
    const exports = registration.factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' || id === '@deepseek-ai/dsh-client-store' ? unused : require(id))
    const Theme = exports.ThemeRuntime as typeof ThemeRuntime
    const listeners = new Set<(snapshot: ThemeSnapshot) => void>(), hostListeners = new Set<() => void>(), cleanups: Array<() => void> = []
    let value = { preference: 'system', fontSize: 14, codeFontSize: 11, terminalFontSize: 13, textFontFamily: '', codeFontFamily: '', terminalFontFamily: '' }
    const host = { getSnapshot: () => ({ value }), subscribe(listener: () => void) { hostListeners.add(listener); return () => { hostListeners.delete(listener) } },
        async set(field: string, next: unknown) { value = { ...value, [field]: next }; for (const listener of hostListeners) listener(); return true } }
    const ctx = { effect(apply: () => (() => void) | undefined) { const cleanup = apply(); if (cleanup) cleanups.push(cleanup) },
        inject() {}, emit(_event: string, snapshot: ThemeSnapshot) { for (const listener of [...listeners]) listener(snapshot) } }
    const theme = new Theme(ctx as never, host as never)
    return { theme, subscribe(listener: (snapshot: ThemeSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
        dispose() { for (const cleanup of cleanups.reverse()) cleanup() } }
}

test('legacy palette/OLED/font/bubble keys migrate by reading original values and only validated colors become tokens', () => {
    const original = storage([['hapi-appearance', 'oled'], ['hapi-font-scale', '1.2'], ['hapi-color-theme', 'codex'],
        ['hapi-theme-colors', JSON.stringify({ oled: { userBubble: '#AABBCC', background: 'url(https://invalid)', text: '#abcdef', arbitrary: '#ffffff' }, light: { border: '#123456' } })]])
    const before = [...original.values], value = readAppearance(original.preferences), tokens = appearanceTokens(value, { fontSizes: { text: 14, code: 11, terminal: 13 } })
    assert.equal(value.enabled, true)
    assert.equal(tokens['--dsw-alias-bg-base']?.dark, '#000000')
    assert.equal(tokens['--dsw-specific-bubble']?.dark, '#aabbcc')
    assert.equal(tokens['--dsw-alias-label-primary']?.dark, '#abcdef')
    assert.equal(tokens['--dsw-alias-border-l2']?.light, '#123456')
    assert.equal(tokens['--dsh-content-font-size']?.dark, '16.8px')
    assert.equal(tokens['--dsh-code-font-size']?.dark, '13.2px')
    assert.equal(Object.values(tokens).some(modes => Object.values(modes).some(value => value.includes('url('))), false)
    assert.deepEqual([...original.values], before, 'reading never deletes or rewrites original data')
    assert.deepEqual(parseColors('{bad'), {})
    assert.deepEqual(parseHeader('{"agent":false,"model":"false","unowned":true}'), { ...DEFAULT_HEADER, agent: false })
    assert.equal(keyColors({ ...value, palette: 'nord', colors: {} }, 'dark').background, '#2e3440')
    original.preferences.dispose()
})

test('real official theme keeps other layers and font choices; plugin disable/dispose retracts only its own tokens', async () => {
    const original = storage([['hapi-appearance', 'oled'], ['hapi-font-scale', '1.2']]), state = new AppearanceState(original.preferences)
    const runtime = officialTheme(), { theme } = runtime
    const other = theme.overrideTokens('third-party', { '--example-third-party': { light: 'kept', dark: 'kept' } })
    const stop = bindAppearanceTheme(state, theme, runtime.subscribe)
    await Promise.resolve()
    assert.equal(theme.getTheme().preference, 'dark')
    assert.equal(theme.getTheme().active.tokens['--dsw-alias-bg-base'], '#000000')
    theme.setFontSize('text', 16); await Promise.resolve()
    assert.equal(theme.getTheme().fontSizes.text, 16)
    assert.equal(theme.getTheme().active.tokens['--dsh-content-font-size'], '19.2px')
    assert.equal(original.preferences.getItem('hapi-appearance'), 'oled', 'font changes do not erase OLED')
    theme.setTheme('light'); await Promise.resolve()
    assert.equal(original.preferences.getItem('hapi-appearance'), 'light', 'official user appearance selection stays authoritative')
    state.write('hapi-dsh-appearance-enabled', 'false')
    assert.equal(theme.getTheme().active.tokens['--dsw-alias-bg-base'], undefined)
    assert.equal(theme.getTheme().active.tokens['--example-third-party'], 'kept')
    state.write('hapi-dsh-appearance-enabled', 'true')
    assert.ok(theme.getTheme().active.tokens['--dsw-specific-bubble'])
    stop()
    assert.equal(theme.getTheme().active.tokens['--dsw-specific-bubble'], undefined)
    assert.equal(theme.getTheme().active.tokens['--example-third-party'], 'kept')
    other(); state.dispose(); original.preferences.dispose(); runtime.dispose()
})

test('terminal adapter is referentially stable, preserves original snapshot and unsubscribes both owners', () => {
    const original = storage([['hapi-terminal-font-size', '9']]), listeners = new Set<() => void>()
    let snapshot = { fontSizes: { text: 14, code: 11, terminal: 13 }, revision: 1 } as ThemeSnapshot
    const observable = { getSnapshot: () => snapshot, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
    const mapped = terminalTheme(observable, original.preferences), first = mapped.getSnapshot()
    assert.equal(first.fontSizes.terminal, 9); assert.equal(snapshot.fontSizes.terminal, 13)
    assert.equal(mapped.getSnapshot(), first)
    let notified = 0
    const stop = mapped.subscribe(() => { notified++ })
    original.preferences.setItem('hapi-terminal-font-size', '17')
    assert.equal(mapped.getSnapshot().fontSizes.terminal, 17)
    snapshot = { ...snapshot, revision: 2 }; for (const listener of listeners) listener()
    assert.equal(mapped.getSnapshot().revision, 2)
    assert.equal(notified, 2)
    original.preferences.setItem('hapi-dsh-appearance-enabled', 'false')
    assert.equal(mapped.getSnapshot(), snapshot)
    stop(); assert.equal(listeners.size, 0)
    const previous = notified; original.preferences.setItem('hapi-terminal-font-size', '11'); assert.equal(notified, previous)
    original.preferences.dispose()
})

test('source header never fabricates creation/activity times from a display proxy or a different Hub', () => {
    const source = { engine: 'codex', hubId: 'source-hub', hapiSessionId: 'source-id', machineName: 'Actual machine', machineId: 'machine',
        model: 'native-model', reasoningEffort: 'high' } as NonNullable<HapiProjection>
    const catalog = { id: 'display', updatedAt: 1000, sourceCreatedAt: 400, sourceLastActiveAt: 800,
        sourceWorktree: { name: 'actual', basePath: '/actual', branch: 'source/branch' }, sourceRowState: { serviceTier: 'fast' },
        projectionValues: { hapi: source } } as WorkspaceCatalogRow
    const header = { ...DEFAULT_HEADER, createdAt: true, updatedAt: true }
    const actual = sourceHeaderFacts(source, null, catalog, header, 'en', 1500)
    assert.equal(actual.find(row => row.key === 'createdAt')?.absolute, 400)
    assert.equal(actual.find(row => row.key === 'lastActive')?.absolute, 800)
    assert.equal(actual.find(row => row.key === 'fastMode')?.value, 'FAST')
    assert.equal(actual.find(row => row.key === 'worktree')?.value, 'source/branch')
    const wrong = { ...catalog, projectionValues: { hapi: { ...source, hubId: 'other-hub' } } } as WorkspaceCatalogRow
    assert.equal(sourceHeaderFacts(source, null, wrong, header, 'en').some(row => row.absolute !== undefined || row.key === 'worktree' || row.key === 'fastMode'), false)
    assert.equal(sourceHeaderFacts(source, null, undefined, header, 'en').some(row => row.absolute !== undefined), false)
    assert.equal(sourceHeaderFacts(source, null, catalog, { ...header, model: false, machine: false }, 'en').some(row => row.key === 'model' || row.key === 'machine'), false)
})

test('storage failure keeps the new page appearance and exposes that it did not persist', () => {
    const preferences = createWorkspaceUiPreferences({ getItem: key => key === 'hapi-appearance' ? 'dark' : null,
        setItem() { throw new Error('Quota exceeded') }, removeItem() { throw new Error('Quota exceeded') } })
    const state = new AppearanceState(preferences)
    state.write('hapi-appearance', 'oled')
    assert.equal(state.getSnapshot().mode, 'oled'); assert.match(state.getSnapshot().saveError ?? '', /Quota exceeded/)
    state.dispose(); preferences.dispose()
})
